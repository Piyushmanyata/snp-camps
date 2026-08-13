-- #21 / D10 — Database consistency pass.
--
-- Convention: every SECURITY DEFINER function uses
--   SET search_path TO 'pg_catalog', 'public'
-- (no exceptions among app RPCs; rls_auto_enable stays pg_catalog-only).
--
-- Items: search_path outliers, delete_camp dead branch, delete_camp_day
-- message encoding, admin desk index, Aadhaar duplicate recoverable override.

-- ---------------------------------------------------------------------------
-- Item 1 — search_path on the eight outliers (ALTER only where body unchanged)
-- ---------------------------------------------------------------------------
ALTER FUNCTION public.active_camp_snapshot()
  SET search_path TO 'pg_catalog', 'public';
ALTER FUNCTION public.camp_day_stats(uuid)
  SET search_path TO 'pg_catalog', 'public';
ALTER FUNCTION public.camp_queue_counts(uuid)
  SET search_path TO 'pg_catalog', 'public';
ALTER FUNCTION public.handle_new_user()
  SET search_path TO 'pg_catalog', 'public';
ALTER FUNCTION public.set_active_camp(uuid)
  SET search_path TO 'pg_catalog', 'public';
ALTER FUNCTION public.upsert_camp_day(uuid, date, integer, uuid)
  SET search_path TO 'pg_catalog', 'public';

-- ---------------------------------------------------------------------------
-- Item 2 + 3 — delete_camp (drop dead branch) + delete_camp_day (ASCII hyphen)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_camp(p_camp_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
declare
  v_count integer;
begin
  if not public.is_admin() then
    raise exception 'admin only';
  end if;

  if not exists (select 1 from public.camps c where c.id = p_camp_id) then
    raise exception 'Camp not found';
  end if;

  select count(*)::int into v_count
  from public.patients p
  where p.camp_id = p_camp_id;

  if v_count > 0 then
    raise exception 'Cannot delete camp with % patient(s). Remove patients first.', v_count;
  end if;

  -- camp_days cascade from camps; days with no patients are safe
  delete from public.camp_days d where d.camp_id = p_camp_id;
  delete from public.camps c where c.id = p_camp_id;
end;
$$;

ALTER FUNCTION public.delete_camp(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delete_camp(uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.delete_camp(uuid) TO service_role;
GRANT ALL ON FUNCTION public.delete_camp(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_camp_day(p_day_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
begin
  if not public.is_admin() then
    raise exception 'admin only';
  end if;
  if exists (select 1 from public.patients p where p.camp_day_id = p_day_id) then
    -- ASCII hyphen only (no em dash) so encoding cannot re-introduce mojibake.
    raise exception 'Cannot delete a day that has patients - reassign them first';
  end if;
  delete from public.camp_days d where d.id = p_day_id;
end;
$$;

ALTER FUNCTION public.delete_camp_day(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delete_camp_day(uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.delete_camp_day(uuid) TO service_role;
GRANT ALL ON FUNCTION public.delete_camp_day(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Item 4 — admin patient desk: camp + created_at DESC
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS patients_camp_created_at_idx
  ON public.patients (camp_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Item 5 — Aadhaar last-4 + name uniqueness with staff override
-- ---------------------------------------------------------------------------
ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS aadhaar_duplicate_override_by uuid
    REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS aadhaar_duplicate_override_at timestamp with time zone;

COMMENT ON COLUMN public.patients.aadhaar_duplicate_override_by IS
  'Staff who explicitly overrode Aadhaar last-4 + name uniqueness for this row.';
COMMENT ON COLUMN public.patients.aadhaar_duplicate_override_at IS
  'When the staff override was applied; null means this row is the unique key holder.';

GRANT SELECT ("aadhaar_duplicate_override_by") ON TABLE public.patients TO authenticated;
GRANT SELECT ("aadhaar_duplicate_override_at") ON TABLE public.patients TO authenticated;

-- One non-overridden row per camp + last4 + normalised name.
-- Override rows set aadhaar_duplicate_override_at and are excluded.
CREATE UNIQUE INDEX IF NOT EXISTS patients_camp_aadhaar_name_uidx
  ON public.patients (camp_id, aadhaar_last4, full_name_normalized)
  WHERE aadhaar_last4 IS NOT NULL
    AND aadhaar_duplicate_override_at IS NULL;

-- Drop old signature; recreate with override flag (default false).
DROP FUNCTION IF EXISTS public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid
);

CREATE OR REPLACE FUNCTION public.register_patient_idempotent(
  p_request_id uuid,
  p_camp_id uuid,
  p_full_name text,
  p_gender text DEFAULT NULL::text,
  p_age integer DEFAULT NULL::integer,
  p_address text DEFAULT NULL::text,
  p_phone text DEFAULT NULL::text,
  p_email text DEFAULT NULL::text,
  p_aadhaar_last4 text DEFAULT NULL::text,
  p_user_id uuid DEFAULT NULL::uuid,
  p_created_by uuid DEFAULT NULL::uuid,
  p_camp_day_id uuid DEFAULT NULL::uuid,
  p_aadhaar_duplicate_override boolean DEFAULT false
) RETURNS TABLE(
  id uuid,
  reg_no integer,
  full_name text,
  camp_day_id uuid,
  day_date date
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_request_role text;
  v_user_id uuid;
  v_created_by uuid;
  v_aadhaar char(4);
  v_name text;
  v_name_norm text;
  v_phone10 text;
  v_existing_reg integer;
  v_conflict_reg integer;
  v_day public.camp_days%rowtype;
  v_taken integer;
  v_row public.patients%rowtype;
  v_override boolean := coalesce(p_aadhaar_duplicate_override, false);
  v_override_by uuid;
  v_override_at timestamptz;
begin
  if p_request_id is null then
    raise exception 'registration request id required';
  end if;

  v_request_role := coalesce(
    nullif(auth.role(), ''),
    nullif(current_setting('request.jwt.claim.role', true), '')
  );

  if v_request_role = 'service_role' then
    v_user_id := p_user_id;
    v_created_by := case when p_user_id is null then p_created_by else null end;
    -- Public / service-role path never gets a silent override.
    if v_override then
      raise exception 'Aadhaar duplicate override requires staff sign-in';
    end if;
  elsif v_request_role = 'authenticated' then
    if not exists (
      select 1
      from public.profiles p
      where p.id = (select auth.uid())
        and p.role in ('admin', 'volunteer')
        and p.disabled_at is null
    ) then
      raise exception 'active admin or volunteer required';
    end if;
    v_user_id := null;
    v_created_by := (select auth.uid());
  else
    raise exception 'authenticated registration required';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('register-request:' || p_request_id::text)
  );

  select p.id, p.reg_no, p.full_name, p.camp_day_id, d.day_date
  into id, reg_no, full_name, camp_day_id, day_date
  from public.patients p
  left join public.camp_days d on d.id = p.camp_day_id
  where p.registration_request_id = p_request_id;

  if found then
    return next;
    return;
  end if;

  v_name := trim(coalesce(p_full_name, ''));
  if length(v_name) = 0 or length(v_name) > 120 then
    raise exception 'full_name required and must be at most 120 characters';
  end if;
  v_name_norm := lower(btrim(v_name));
  if p_age is not null and (p_age < 0 or p_age >= 150) then
    raise exception 'age must be between 0 and 149';
  end if;

  if not exists (
    select 1
    from public.camps c
    where c.id = p_camp_id and c.is_active
  ) then
    raise exception 'No active camp';
  end if;

  if p_camp_day_id is null then
    raise exception 'Please select a camp day';
  end if;

  if v_user_id is not null then
    perform pg_advisory_xact_lock(
      hashtext('register-user:' || p_camp_id::text || ':' || v_user_id::text)
    );

    select p.reg_no
    into v_existing_reg
    from public.patients p
    where p.camp_id = p_camp_id
      and p.user_id = v_user_id
    limit 1;

    if v_existing_reg is not null then
      raise exception
        'Already registered for this camp (reg no %). Change day instead.',
        v_existing_reg;
    end if;
  end if;

  select *
  into v_day
  from public.camp_days d
  where d.id = p_camp_day_id
  for update;

  if v_day.id is null or v_day.camp_id is distinct from p_camp_id then
    raise exception 'Invalid camp day';
  end if;

  select count(*)::integer
  into v_taken
  from public.patients p
  where p.camp_day_id = p_camp_day_id;

  if v_taken >= v_day.seat_limit then
    raise exception 'This day is full (% seats). Choose another day.', v_day.seat_limit;
  end if;

  if p_aadhaar_last4 is null or length(trim(p_aadhaar_last4)) = 0 then
    v_aadhaar := null;
  else
    v_aadhaar := right(regexp_replace(p_aadhaar_last4, '\D', '', 'g'), 4);
    if v_aadhaar !~ '^[0-9]{4}$' then
      raise exception 'Invalid aadhaar last4';
    end if;
  end if;

  v_phone10 := nullif(
    right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10),
    ''
  );
  if v_phone10 is not null and length(v_phone10) < 10 then
    v_phone10 := null;
  end if;

  -- Mapped Aadhaar last-4 + name collision (never raw unique_violation text).
  if v_aadhaar is not null then
    select p.reg_no
    into v_conflict_reg
    from public.patients p
    where p.camp_id = p_camp_id
      and p.aadhaar_last4 = v_aadhaar
      and p.full_name_normalized = v_name_norm
      and p.aadhaar_duplicate_override_at is null
    limit 1;

    if v_conflict_reg is not null then
      if not v_override then
        raise exception 'AADHAAR_DUPLICATE:reg=%', v_conflict_reg;
      end if;
      if v_request_role is distinct from 'authenticated' then
        raise exception 'Aadhaar duplicate override requires staff sign-in';
      end if;
      v_override_by := (select auth.uid());
      v_override_at := now();
    end if;
  end if;

  begin
    insert into public.patients (
      registration_request_id,
      camp_id,
      camp_day_id,
      user_id,
      full_name,
      gender,
      age,
      address,
      phone,
      email,
      aadhaar_last4,
      created_by,
      queue_status,
      queued_at,
      aadhaar_duplicate_override_by,
      aadhaar_duplicate_override_at
    )
    values (
      p_request_id,
      p_camp_id,
      p_camp_day_id,
      v_user_id,
      v_name,
      case when p_gender in ('M', 'F', 'O') then p_gender else null end,
      p_age,
      nullif(trim(coalesce(p_address, '')), ''),
      v_phone10,
      nullif(trim(coalesce(p_email, '')), ''),
      v_aadhaar,
      v_created_by,
      'registered',
      null,
      v_override_by,
      v_override_at
    )
    returning public.patients.* into v_row;
  exception
    when unique_violation then
      -- Race: another insert won the unique index between select and insert.
      select p.reg_no
      into v_conflict_reg
      from public.patients p
      where p.camp_id = p_camp_id
        and p.aadhaar_last4 = v_aadhaar
        and p.full_name_normalized = v_name_norm
        and p.aadhaar_duplicate_override_at is null
      limit 1;
      if v_conflict_reg is not null then
        raise exception 'AADHAAR_DUPLICATE:reg=%', v_conflict_reg;
      end if;
      raise;
  end;

  id := v_row.id;
  reg_no := v_row.reg_no;
  full_name := v_row.full_name;
  camp_day_id := v_row.camp_day_id;
  day_date := v_day.day_date;
  return next;
end;
$function$;

ALTER FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid, boolean
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid, boolean
) FROM PUBLIC;
GRANT ALL ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid, boolean
) TO service_role;
GRANT ALL ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid, boolean
) TO authenticated;

-- Keep readiness contract green until #22 retires it (signature gained boolean).
CREATE OR REPLACE FUNCTION public.app_database_contract() RETURNS text
    LANGUAGE sql
    STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select case
    when to_regprocedure(
      'public.register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean)'
    ) is not null
      and to_regprocedure('public.doctor_recent_patients(uuid,integer)') is not null
      and to_regprocedure('public.link_patient_phone(text,uuid)') is not null
      and exists (
        select 1
        from pg_catalog.pg_attribute a
        join pg_catalog.pg_class c on c.oid = a.attrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname = 'patients'
          and a.attname = 'registration_request_id'
          and a.attnum > 0
          and not a.attisdropped
      )
      and exists (
        select 1
        from pg_catalog.pg_attribute a
        join pg_catalog.pg_class c on c.oid = a.attrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname = 'patients'
          and a.attname = 'passcode_issued_at'
          and a.attnum > 0
          and not a.attisdropped
      )
    then '20260722005000'
    else 'incomplete'
  end;
$$;

ALTER FUNCTION public.app_database_contract() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.app_database_contract() FROM PUBLIC;
GRANT ALL ON FUNCTION public.app_database_contract() TO service_role;
