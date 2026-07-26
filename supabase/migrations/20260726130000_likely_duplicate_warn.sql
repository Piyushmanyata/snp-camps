-- #48 — Soft duplicate warning at desk registration (warn, never block).
-- Match within active camp only: (normalised name + age) OR phone (both set).
-- Aadhaar last-4 uniqueness unchanged. Indexes keep submit path hot.

-- ---------------------------------------------------------------------------
-- Audit columns for staff "register anyway" (same shape as Aadhaar override)
-- ---------------------------------------------------------------------------
ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS likely_duplicate_override_by uuid
    REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS likely_duplicate_override_at timestamp with time zone;

COMMENT ON COLUMN public.patients.likely_duplicate_override_by IS
  'Staff who chose Register anyway after a soft-duplicate warning (#48).';
COMMENT ON COLUMN public.patients.likely_duplicate_override_at IS
  'When Register anyway was used after a soft-duplicate warning (#48).';

GRANT SELECT ("likely_duplicate_override_by") ON TABLE public.patients TO authenticated;
GRANT SELECT ("likely_duplicate_override_at") ON TABLE public.patients TO authenticated;

-- ---------------------------------------------------------------------------
-- Indexed match keys (camp-scoped; used only at submit)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS patients_camp_name_age_idx
  ON public.patients (camp_id, full_name_normalized, age)
  WHERE age IS NOT NULL;

CREATE INDEX IF NOT EXISTS patients_camp_phone_normalized_idx
  ON public.patients (camp_id, phone_normalized)
  WHERE phone_normalized IS NOT NULL;

-- ---------------------------------------------------------------------------
-- register_patient_idempotent — soft warn + one-shot likely override
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid, boolean
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
  p_aadhaar_duplicate_override boolean DEFAULT false,
  p_likely_duplicate_override boolean DEFAULT false
) RETURNS TABLE(
  id uuid,
  reg_no integer,
  full_name text,
  camp_day_id uuid,
  day_date date,
  queue_status public.queue_status
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
  v_soft_reg integer;
  v_day public.camp_days%rowtype;
  v_taken integer;
  v_row public.patients%rowtype;
  v_override boolean := coalesce(p_aadhaar_duplicate_override, false);
  v_likely_override boolean := coalesce(p_likely_duplicate_override, false);
  v_override_by uuid;
  v_override_at timestamptz;
  v_likely_by uuid;
  v_likely_at timestamptz;
  v_today date;
  v_is_walkin boolean;
  v_status public.queue_status;
  v_queued_at timestamptz;
  v_checked_in_by uuid;
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
    if v_override then
      raise exception 'Aadhaar duplicate override requires staff sign-in';
    end if;
    if v_likely_override then
      raise exception 'Likely-duplicate override requires staff sign-in';
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

  select p.id, p.reg_no, p.full_name, p.camp_day_id, d.day_date, p.queue_status
  into id, reg_no, full_name, camp_day_id, day_date, queue_status
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
  v_name_norm := lower(btrim(regexp_replace(v_name, '\s+', ' ', 'g')));
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

  -- Camp day = today (Asia/Kolkata) → walk-in: register + check-in in one step.
  v_today := (timezone('Asia/Kolkata', now()))::date;
  v_is_walkin := v_day.day_date = v_today;
  if v_is_walkin then
    v_status := 'waiting';
    v_queued_at := now();
    v_checked_in_by := coalesce((select auth.uid()), v_created_by);
  else
    v_status := 'registered';
    v_queued_at := null;
    v_checked_in_by := null;
  end if;

  -- Soft duplicate (#48): warn-only; never a unique constraint.
  -- Prefer lowest reg_no (earliest registration) when several match.
  select p.reg_no
  into v_soft_reg
  from public.patients p
  where p.camp_id = p_camp_id
    and (
      (
        p_age is not null
        and p.age is not null
        and p.full_name_normalized = v_name_norm
        and p.age = p_age
      )
      or (
        v_phone10 is not null
        and p.phone_normalized is not null
        and p.phone_normalized = v_phone10
      )
    )
  order by p.reg_no
  limit 1;

  if v_soft_reg is not null then
    if not v_likely_override then
      raise exception 'LIKELY_DUPLICATE:reg=%', v_soft_reg;
    end if;
    if v_request_role is distinct from 'authenticated' then
      raise exception 'Likely-duplicate override requires staff sign-in';
    end if;
    v_likely_by := (select auth.uid());
    v_likely_at := now();
  end if;

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
      checked_in_by,
      aadhaar_duplicate_override_by,
      aadhaar_duplicate_override_at,
      likely_duplicate_override_by,
      likely_duplicate_override_at
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
      v_status,
      v_queued_at,
      v_checked_in_by,
      v_override_by,
      v_override_at,
      v_likely_by,
      v_likely_at
    )
    returning public.patients.* into v_row;
  exception
    when unique_violation then
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
  queue_status := v_row.queue_status;
  return next;
end;
$function$;

ALTER FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid, boolean, boolean
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid, boolean, boolean
) FROM PUBLIC;
GRANT ALL ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid, boolean, boolean
) TO service_role;
GRANT ALL ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid, boolean, boolean
) TO authenticated;
