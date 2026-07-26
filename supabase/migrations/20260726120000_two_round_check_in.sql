-- #46 — Two-round workflow: registered → waiting → seen with check-in.
-- No production data. Destructive migration OK.
--
-- Lifecycle:
--   registered — pre-reg, not in FCFS Queue
--   waiting    — checked in (physically present); FCFS by queued_at
--   seen       — doctor done (terminal)
--
-- Walk-in (camp day = today Asia/Kolkata): register lands in waiting.
-- Pre-reg (future day): stays registered until check_in_patient.

-- ---------------------------------------------------------------------------
-- Name normalisation: case-fold + collapse internal whitespace
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS public.patients_full_name_trgm_idx;
DROP INDEX IF EXISTS public.patients_camp_aadhaar_name_uidx;

ALTER TABLE public.patients
  DROP COLUMN IF EXISTS full_name_normalized;

ALTER TABLE public.patients
  ADD COLUMN full_name_normalized text
  GENERATED ALWAYS AS (
    lower(btrim(regexp_replace(full_name, '\s+', ' ', 'g')))
  ) STORED;

CREATE INDEX patients_full_name_trgm_idx
  ON public.patients
  USING gin (full_name_normalized extensions.gin_trgm_ops);

CREATE UNIQUE INDEX patients_camp_aadhaar_name_uidx
  ON public.patients (camp_id, aadhaar_last4, full_name_normalized)
  WHERE aadhaar_last4 IS NOT NULL
    AND aadhaar_duplicate_override_at IS NULL;

-- Prefix search for registered patients at the desk (lost slip, no phone).
CREATE INDEX patients_camp_registered_name_prefix_idx
  ON public.patients (camp_id, full_name_normalized text_pattern_ops)
  WHERE queue_status = 'registered';

GRANT SELECT ("full_name_normalized") ON TABLE public.patients TO authenticated;

COMMENT ON COLUMN public.patients.full_name_normalized IS
  'lower(trim(collapse-whitespace(full_name))) for Aadhaar uniqueness and desk name search.';

-- ---------------------------------------------------------------------------
-- check_in_patient — single server op for QR / reg no / name-row tap
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_in_patient(
  p_patient_id uuid DEFAULT NULL::uuid,
  p_reg_no integer DEFAULT NULL::integer
) RETURNS TABLE(
  id uuid,
  reg_no integer,
  full_name text,
  queue_status public.queue_status,
  already_waiting boolean,
  doctor_name text,
  error_code text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
declare
  r public.patients%rowtype;
  v_doctor_name text;
begin
  if not public.is_staff() then
    raise exception 'staff only';
  end if;

  if p_patient_id is not null then
    select * into r
    from public.patients p
    where p.id = p_patient_id
    for update;
  elsif p_reg_no is not null then
    select * into r
    from public.patients p
    where p.reg_no = p_reg_no
    for update;
  else
    raise exception 'Provide patient id or reg no';
  end if;

  if r.id is null then
    raise exception 'Patient not found';
  end if;

  if not exists (
    select 1
    from public.camps c
    where c.id = r.camp_id
      and c.is_active
  ) then
    raise exception 'Patient belongs to an inactive camp';
  end if;

  -- Seen is terminal; same message shape as assign/scan paths.
  if r.queue_status = 'seen' then
    select p.full_name
    into v_doctor_name
    from public.profiles p
    where p.id = r.seen_by;

    return query
    select
      r.id,
      r.reg_no,
      r.full_name,
      r.queue_status,
      false,
      coalesce(v_doctor_name, 'Unknown'),
      'already_seen'::text;
    return;
  end if;

  -- Idempotent: already waiting — succeed, do not reorder queue.
  if r.queue_status = 'waiting' then
    return query
    select
      r.id,
      r.reg_no,
      r.full_name,
      r.queue_status,
      true,
      null::text,
      null::text;
    return;
  end if;

  if r.queue_status is distinct from 'registered' then
    raise exception 'Unsupported patient queue status';
  end if;

  update public.patients p
  set queue_status = 'waiting',
      queued_at = now(),
      checked_in_by = coalesce(p.checked_in_by, (select auth.uid()))
  where p.id = r.id
  returning p.* into r;

  return query
  select
    r.id,
    r.reg_no,
    r.full_name,
    r.queue_status,
    false,
    null::text,
    null::text;
end;
$$;

ALTER FUNCTION public.check_in_patient(uuid, integer) OWNER TO postgres;
COMMENT ON FUNCTION public.check_in_patient(uuid, integer) IS
  'Staff check-in: registered → waiting. Idempotent for waiting; blocks seen. QR, reg no, and name search all call this.';
REVOKE ALL ON FUNCTION public.check_in_patient(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_in_patient(uuid, integer) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- search_registered_patients — desk name search (registered only, active camp)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_registered_patients(
  p_camp_id uuid,
  p_query text,
  p_limit integer DEFAULT 10
) RETURNS TABLE(
  id uuid,
  reg_no integer,
  full_name text,
  age integer,
  address text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
declare
  v_q text;
  v_lim integer;
begin
  if not public.is_staff() then
    raise exception 'staff only';
  end if;

  if p_camp_id is null then
    raise exception 'camp required';
  end if;

  if not exists (
    select 1
    from public.camps c
    where c.id = p_camp_id
      and c.is_active
  ) then
    raise exception 'No active camp';
  end if;

  v_q := lower(btrim(regexp_replace(coalesce(p_query, ''), '\s+', ' ', 'g')));
  if length(v_q) < 1 then
    return;
  end if;

  v_lim := greatest(1, least(coalesce(p_limit, 10), 25));

  return query
  select
    p.id,
    p.reg_no,
    p.full_name,
    p.age,
    p.address
  from public.patients p
  where p.camp_id = p_camp_id
    and p.queue_status = 'registered'
    and p.full_name_normalized like v_q || '%'
  order by p.full_name_normalized, p.reg_no
  limit v_lim;
end;
$$;

ALTER FUNCTION public.search_registered_patients(uuid, text, integer) OWNER TO postgres;
COMMENT ON FUNCTION public.search_registered_patients(uuid, text, integer) IS
  'Prefix name search of registered (not yet checked-in) patients for the active camp. Returns name, age, address (locality).';
REVOKE ALL ON FUNCTION public.search_registered_patients(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_registered_patients(uuid, text, integer) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- register_patient_idempotent — walk-in same-day auto check-in; return status
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
  p_aadhaar_duplicate_override boolean DEFAULT false
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
  v_day public.camp_days%rowtype;
  v_taken integer;
  v_row public.patients%rowtype;
  v_override boolean := coalesce(p_aadhaar_duplicate_override, false);
  v_override_by uuid;
  v_override_at timestamptz;
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
      v_status,
      v_queued_at,
      v_checked_in_by,
      v_override_by,
      v_override_at
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
