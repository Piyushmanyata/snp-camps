-- #59 — Complete patient-Auth retirement (capability + ownership column).
-- Parent #55. Builds on #56 least-privilege SELECT (no doctor broad read).
--
-- Production-bearing: inventory counts first (see .scratch/remediation-59).
-- Identity deletion (auth.users / patient-role profiles) requires #34 authority.
-- This migration detaches ownership and removes executable patient-Auth seams.
-- Rollback may restore a staff-only provisioning helper; must never restore
-- link_patient_phone, patient self-RLS, or public patient ownership.

-- ---------------------------------------------------------------------------
-- 1. Drop patient phone-linking RPC (all overloads)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.link_patient_phone(text);
DROP FUNCTION IF EXISTS public.link_patient_phone(text, uuid);

-- ---------------------------------------------------------------------------
-- 2. SELECT policy: admin + active-camp staff only (no self-read branch)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "authenticated read permitted patients" ON public.patients;

CREATE POLICY "authenticated read permitted patients"
  ON public.patients
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_admin())
    OR (
      (SELECT public.is_staff())
      AND EXISTS (
        SELECT 1
        FROM public.camps c
        WHERE c.id = patients.camp_id
          AND c.is_active
      )
    )
  );

-- ---------------------------------------------------------------------------
-- 3. change_camp_day: staff only (no patient-owner self-mutation)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.change_camp_day(
  p_patient_id uuid,
  p_new_day_id uuid
)
RETURNS TABLE (
  id uuid,
  reg_no integer,
  full_name text,
  camp_day_id uuid,
  day_date date
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
declare
  r public.patients%rowtype;
  v_new public.camp_days%rowtype;
  v_taken integer;
  v_camp_active boolean;
begin
  if not public.is_staff() then
    raise exception 'Not allowed';
  end if;

  select *
  into r
  from public.patients p
  where p.id = p_patient_id
  for update;

  if r.id is null then
    raise exception 'Patient not found';
  end if;

  select c.is_active
  into v_camp_active
  from public.camps c
  where c.id = r.camp_id
  for share;

  if v_camp_active is distinct from true then
    raise exception 'Camp is no longer active';
  end if;

  if r.queue_status in ('waiting', 'seen') then
    raise exception 'Cannot change camp day after joining the queue';
  end if;

  select *
  into v_new
  from public.camp_days d
  where d.id = p_new_day_id
  for update;

  if v_new.id is null then
    raise exception 'Day not found';
  end if;
  if v_new.camp_id is distinct from r.camp_id then
    raise exception 'Day does not belong to this camp';
  end if;

  if r.camp_day_id is not distinct from p_new_day_id then
    return query
    select r.id, r.reg_no, r.full_name, r.camp_day_id, v_new.day_date;
    return;
  end if;

  select count(*)::integer
  into v_taken
  from public.patients p
  where p.camp_day_id = p_new_day_id;

  if v_taken >= v_new.seat_limit then
    raise exception 'That day is full (% seats taken)', v_taken;
  end if;

  update public.patients p
  set camp_day_id = p_new_day_id
  where p.id = r.id
  returning p.* into r;

  return query
  select r.id, r.reg_no, r.full_name, r.camp_day_id, v_new.day_date;
end;
$$;

ALTER FUNCTION public.change_camp_day(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.change_camp_day(uuid, uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.change_camp_day(uuid, uuid) TO service_role;
GRANT ALL ON FUNCTION public.change_camp_day(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.change_camp_day(uuid, uuid) IS
  'Staff-only day reassignment. Patient Auth self-mutation retired (#59).';

-- ---------------------------------------------------------------------------
-- 4. Stop automatic patient profile creation on Auth signup
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
begin
  -- Patient Auth is retired. Staff profiles are written explicitly by
  -- admin provisioning (service_role upsert). Do not auto-insert.
  return new;
end;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;
GRANT ALL ON FUNCTION public.handle_new_user() TO service_role;

COMMENT ON FUNCTION public.handle_new_user() IS
  'No-op after #59. Staff profiles are provisioned explicitly; patients do not authenticate.';

-- Drop trigger if present on auth.users (name may vary by environment).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT t.tgname
    FROM pg_trigger t
    JOIN pg_proc p ON t.tgfoid = p.oid
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE NOT t.tgisinternal
      AND t.tgrelid = 'auth.users'::regclass
      AND n.nspname = 'public'
      AND p.proname = 'handle_new_user'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON auth.users', r.tgname);
  END LOOP;
END $$;

-- profiles.role must be explicit; never default to patient.
ALTER TABLE public.profiles
  ALTER COLUMN role DROP DEFAULT;

COMMENT ON COLUMN public.profiles.role IS
  'Staff role only in practice (admin|volunteer|doctor). patient enum value is legacy/unreachable; no auto-insert (#59).';

-- ---------------------------------------------------------------------------
-- 5. Detach ownership links (counts only in migration notices; no PII)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_linked integer;
BEGIN
  SELECT count(*)::int INTO v_linked
  FROM public.patients
  WHERE user_id IS NOT NULL;

  RAISE NOTICE 'retire_patient_auth: patients.user_id non-null before detach = %', v_linked;

  UPDATE public.patients
  SET user_id = NULL
  WHERE user_id IS NOT NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 6. register_patient_idempotent: ignore ownership; never write user_id
--    Keep p_user_id in the signature for call compatibility; it is unused.
-- ---------------------------------------------------------------------------
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
  v_created_by uuid;
  v_aadhaar char(4);
  v_name text;
  v_name_norm text;
  v_phone10 text;
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

  -- p_user_id is intentionally ignored: patient Auth ownership retired (#59).

  v_request_role := coalesce(
    nullif(auth.role(), ''),
    nullif(current_setting('request.jwt.claim.role', true), '')
  );

  if v_request_role = 'service_role' then
    v_created_by := p_created_by;
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

COMMENT ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid, boolean, boolean
) IS
  'Staff registration. p_user_id is ignored (patient Auth retired #59).';

-- ---------------------------------------------------------------------------
-- 7. Drop ownership column + indexes + FK (after function no longer writes it)
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS public.patients_camp_user_unique_idx;
DROP INDEX IF EXISTS public.patients_user_id_idx;

ALTER TABLE public.patients
  DROP CONSTRAINT IF EXISTS patients_user_id_fkey;

ALTER TABLE public.patients
  DROP COLUMN IF EXISTS user_id;

-- ---------------------------------------------------------------------------
-- 8. Catalog assertions (fail migration if containment incomplete)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regprocedure('public.link_patient_phone(text)') IS NOT NULL
     OR to_regprocedure('public.link_patient_phone(text,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'link_patient_phone still present after #59 retirement';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'patients'
      AND column_name = 'user_id'
  ) THEN
    RAISE EXCEPTION 'patients.user_id still present after #59 retirement';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'profiles'
      AND column_name = 'role'
      AND column_default IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'profiles.role still has a DEFAULT after #59';
  END IF;
END $$;
