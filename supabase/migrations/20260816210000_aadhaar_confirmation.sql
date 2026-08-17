ALTER TABLE public.persons
  ADD COLUMN IF NOT EXISTS address_locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS merged_into uuid REFERENCES public.persons(id),
  ADD COLUMN IF NOT EXISTS merged_at timestamptz,
  ADD COLUMN IF NOT EXISTS confirmation_replaced jsonb;

ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS confirmation_override_actor uuid,
  ADD COLUMN IF NOT EXISTS confirmation_override_at timestamptz,
  ADD COLUMN IF NOT EXISTS confirmation_override_reason text;

CREATE OR REPLACE FUNCTION public.enforce_person_field_locks()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
  IF NEW.aadhaar_locked_at IS NOT NULL AND NEW.address_locked_at IS NULL THEN
    NEW.address_locked_at := NEW.aadhaar_locked_at;
  END IF;

  IF OLD.aadhaar_locked_at IS NOT NULL
     AND NEW.aadhaar_last4 IS DISTINCT FROM OLD.aadhaar_last4
  THEN
    RAISE EXCEPTION 'Aadhaar field is locked and cannot be modified';
  END IF;

  IF OLD.name_locked_at IS NOT NULL
     AND NEW.full_name IS DISTINCT FROM OLD.full_name
  THEN
    RAISE EXCEPTION 'Name field is locked and cannot be modified';
  END IF;

  IF OLD.aadhaar_locked_at IS NOT NULL
     AND NEW.date_of_birth IS DISTINCT FROM OLD.date_of_birth
  THEN
    RAISE EXCEPTION 'Date of birth field is locked and cannot be modified';
  END IF;

  IF OLD.aadhaar_locked_at IS NOT NULL
     AND NEW.gender IS DISTINCT FROM OLD.gender
  THEN
    RAISE EXCEPTION 'Gender field is locked and cannot be modified';
  END IF;

  IF OLD.address_locked_at IS NOT NULL
     AND NEW.address IS DISTINCT FROM OLD.address
  THEN
    RAISE EXCEPTION 'Address field is locked and cannot be modified';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_manual_exception_aadhaar(
  p_patient_id uuid,
  p_mode text,
  p_duplicate_key text DEFAULT NULL,
  p_full_name text DEFAULT NULL,
  p_date_of_birth date DEFAULT NULL,
  p_gender text DEFAULT NULL,
  p_aadhaar_last4 text DEFAULT NULL,
  p_address text DEFAULT NULL,
  p_keep_display_name boolean DEFAULT false,
  p_actor_id uuid DEFAULT NULL,
  p_override_reason text DEFAULT NULL
)
RETURNS TABLE(
  outcome text,
  surviving_reg_no integer,
  surviving_name text,
  surviving_age integer,
  surviving_gender text,
  typed_full_name text,
  typed_date_of_birth date,
  typed_gender text,
  typed_aadhaar_last4 text,
  typed_address text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_role public.user_role;
  r_patient public.patients%rowtype;
  r_person public.persons%rowtype;
  r_other public.persons%rowtype;
  v_age integer;
BEGIN
  SELECT pr.role INTO v_role
  FROM public.profiles AS pr
  WHERE pr.id = p_actor_id AND pr.disabled_at IS NULL;

  IF v_role IS NULL OR v_role NOT IN (
    'admin'::public.user_role,
    'team_lead'::public.user_role,
    'volunteer'::public.user_role
  ) THEN
    RAISE EXCEPTION 'staff only';
  END IF;

  SELECT * INTO r_patient
  FROM public.patients AS p
  WHERE p.id = p_patient_id
  FOR UPDATE;

  IF r_patient.id IS NULL THEN
    RAISE EXCEPTION 'Patient not found';
  END IF;

  SELECT * INTO r_person
  FROM public.persons AS pe
  WHERE pe.id = r_patient.person_id
  FOR UPDATE;

  IF r_patient.provenance IS DISTINCT FROM 'manual_exception'
     OR r_person.duplicate_key IS NOT NULL
  THEN
    RETURN QUERY SELECT
      'not_required'::text, r_person.reg_no, r_person.full_name,
      r_patient.age, r_person.gender, r_person.full_name, r_person.date_of_birth,
      r_person.gender, r_person.aadhaar_last4::text, r_person.address;
    RETURN;
  END IF;

  IF p_mode = 'override' THEN
    IF v_role = 'volunteer'::public.user_role THEN
      RAISE EXCEPTION 'VOLUNTEER_OVERRIDE_FORBIDDEN';
    END IF;
    IF nullif(btrim(coalesce(p_override_reason, '')), '') IS NULL THEN
      RAISE EXCEPTION 'override reason required';
    END IF;
    UPDATE public.patients AS p
    SET confirmation_override_actor = p_actor_id,
        confirmation_override_at = now(),
        confirmation_override_reason = left(btrim(p_override_reason), 500)
    WHERE p.id = r_patient.id;
    RETURN QUERY SELECT
      'overridden'::text, r_person.reg_no, r_person.full_name,
      r_patient.age, r_person.gender, r_person.full_name, r_person.date_of_birth,
      r_person.gender, r_person.aadhaar_last4::text, r_person.address;
    RETURN;
  END IF;

  IF p_duplicate_key IS NULL OR btrim(p_duplicate_key) = '' THEN
    RETURN QUERY SELECT
      'needs_scan'::text, r_person.reg_no, r_person.full_name,
      r_patient.age, r_person.gender, r_person.full_name, r_person.date_of_birth,
      r_person.gender, r_person.aadhaar_last4::text, r_person.address;
    RETURN;
  END IF;

  PERFORM 1
  FROM public.persons AS pe
  WHERE pe.duplicate_key = p_duplicate_key
  ORDER BY pe.id
  FOR UPDATE;

  SELECT * INTO r_other
  FROM public.persons AS pe
  WHERE pe.duplicate_key = p_duplicate_key
    AND pe.id IS DISTINCT FROM r_person.id
  LIMIT 1;

  IF p_mode = 'inspect' THEN
    IF r_other.id IS NULL THEN
      RETURN QUERY SELECT
        'free'::text, r_person.reg_no, r_person.full_name,
        r_patient.age, r_person.gender, r_person.full_name, r_person.date_of_birth,
        r_person.gender, r_person.aadhaar_last4::text, r_person.address;
    ELSE
      RETURN QUERY SELECT
        'collision'::text, r_other.reg_no, r_other.full_name,
        date_part('year', age(coalesce(r_other.date_of_birth, current_date)))::integer,
        r_other.gender, r_person.full_name, r_person.date_of_birth,
        r_person.gender, r_person.aadhaar_last4::text, r_person.address;
    END IF;
    RETURN;
  END IF;

  IF p_mode IS DISTINCT FROM 'commit' THEN
    RAISE EXCEPTION 'invalid confirmation mode';
  END IF;

  v_age := date_part('year', age(coalesce(p_date_of_birth, current_date)))::integer;

  IF r_other.id IS NULL THEN
    BEGIN
      UPDATE public.persons AS pe
      SET confirmation_replaced = jsonb_build_object(
            'full_name', pe.full_name,
            'date_of_birth', pe.date_of_birth,
            'gender', pe.gender,
            'aadhaar_last4', pe.aadhaar_last4,
            'address', pe.address
          ),
          full_name = coalesce(nullif(btrim(p_full_name), ''), pe.full_name),
          date_of_birth = coalesce(p_date_of_birth, pe.date_of_birth),
          gender = coalesce(nullif(btrim(p_gender), ''), pe.gender),
          aadhaar_last4 = coalesce(nullif(btrim(p_aadhaar_last4), ''), pe.aadhaar_last4),
          address = coalesce(p_address, pe.address),
          duplicate_key = p_duplicate_key,
          aadhaar_locked_at = coalesce(pe.aadhaar_locked_at, now()),
          name_locked_at = coalesce(pe.name_locked_at, now()),
          address_locked_at = coalesce(pe.address_locked_at, now())
      WHERE pe.id = r_person.id
      RETURNING * INTO r_person;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'AADHAAR_KEY_TAKEN';
    END;

    UPDATE public.patients AS p
    SET full_name = r_person.full_name,
        gender = r_person.gender,
        age = v_age,
        address = r_person.address,
        aadhaar_last4 = r_person.aadhaar_last4,
        display_name = r_person.display_name
    WHERE p.id = r_patient.id;

    RETURN QUERY SELECT
      'committed'::text, r_person.reg_no, r_person.full_name,
      v_age, r_person.gender, r_person.full_name, r_person.date_of_birth,
      r_person.gender, r_person.aadhaar_last4::text, r_person.address;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.patients AS p
    WHERE p.person_id = r_other.id
      AND p.camp_id = r_patient.camp_id
      AND p.id IS DISTINCT FROM r_patient.id
  ) THEN
    RAISE EXCEPTION 'PERSON_ALREADY_REGISTERED:reg=%', r_other.reg_no;
  END IF;

  UPDATE public.patients AS p
  SET person_id = r_other.id,
      reg_no = r_other.reg_no,
      full_name = r_other.full_name,
      gender = r_other.gender,
      age = coalesce(
        date_part('year', age(coalesce(r_other.date_of_birth, p_date_of_birth, current_date)))::integer,
        p.age
      ),
      address = coalesce(r_other.address, p_address, p.address),
      aadhaar_last4 = coalesce(r_other.aadhaar_last4, p_aadhaar_last4),
      display_name = CASE
        WHEN p_keep_display_name THEN coalesce(r_person.display_name, p.display_name)
        ELSE coalesce(r_other.display_name, p.display_name)
      END
  WHERE p.id = r_patient.id;

  UPDATE public.persons AS pe
  SET merged_into = r_other.id,
      merged_at = now()
  WHERE pe.id = r_person.id
    AND pe.merged_into IS NULL;

  RETURN QUERY SELECT
    'merged'::text, r_other.reg_no, r_other.full_name,
    date_part('year', age(coalesce(r_other.date_of_birth, current_date)))::integer,
    r_other.gender, r_person.full_name, r_person.date_of_birth,
    r_person.gender, r_person.aadhaar_last4::text, r_person.address;
END;
$function$;

ALTER FUNCTION public.confirm_manual_exception_aadhaar(
  uuid, text, text, text, date, text, text, text, boolean, uuid, text
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.confirm_manual_exception_aadhaar(
  uuid, text, text, text, date, text, text, text, boolean, uuid, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_manual_exception_aadhaar(
  uuid, text, text, text, date, text, text, text, boolean, uuid, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.readiness_catalog_probe()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v jsonb;
BEGIN
  v := public.readiness_catalog_probe_20260813();
  v := jsonb_set(
    v,
    '{columns}',
    coalesce(v->'columns', '{}'::jsonb) || jsonb_build_object(
      'camp_days.printing_open',
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'camp_days'
          AND column_name = 'printing_open'
      ),
      'persons.address_locked_at',
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'persons'
          AND column_name = 'address_locked_at'
      ),
      'persons.merged_into',
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'persons'
          AND column_name = 'merged_into'
      ),
      'patients.confirmation_override_actor',
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'patients'
          AND column_name = 'confirmation_override_actor'
      )
    )
  );
  v := jsonb_set(
    v,
    '{functions}',
    coalesce(v->'functions', '{}'::jsonb) || jsonb_build_object(
      'set_camp_day_printing_open',
      to_regprocedure('public.set_camp_day_printing_open(uuid,boolean)') IS NOT NULL,
      'confirm_manual_exception_aadhaar',
      to_regprocedure('public.confirm_manual_exception_aadhaar(uuid,text,text,text,date,text,text,text,boolean,uuid,text)') IS NOT NULL
    )
  );
  v := jsonb_set(
    v,
    '{grants}',
    coalesce(v->'grants', '{}'::jsonb) || jsonb_build_object(
      'set_camp_day_printing_open_authenticated_execute',
      CASE WHEN to_regprocedure('public.set_camp_day_printing_open(uuid,boolean)') IS NOT NULL
        THEN has_function_privilege('authenticated','public.set_camp_day_printing_open(uuid,boolean)','EXECUTE')
        ELSE false END,
      'set_camp_day_printing_open_anon_execute',
      CASE WHEN to_regprocedure('public.set_camp_day_printing_open(uuid,boolean)') IS NOT NULL
        THEN has_function_privilege('anon','public.set_camp_day_printing_open(uuid,boolean)','EXECUTE')
        ELSE false END,
      'confirm_manual_exception_aadhaar_authenticated_execute', false,
      'confirm_manual_exception_aadhaar_anon_execute', false,
      'confirm_manual_exception_aadhaar_service_role_execute',
      CASE WHEN to_regprocedure('public.confirm_manual_exception_aadhaar(uuid,text,text,text,date,text,text,text,boolean,uuid,text)') IS NOT NULL
        THEN has_function_privilege('service_role','public.confirm_manual_exception_aadhaar(uuid,text,text,text,date,text,text,text,boolean,uuid,text)','EXECUTE')
        ELSE false END
    )
  );
  RETURN v;
END;
$function$;

CREATE OR REPLACE FUNCTION public.mark_patient_printed(
  p_patient_id uuid DEFAULT NULL,
  p_reg_no integer DEFAULT NULL
)
RETURNS TABLE(
  id uuid,
  reg_no integer,
  full_name text,
  queue_status public.queue_status,
  already_printed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  r public.patients%rowtype;
  v_already boolean;
BEGIN
  IF NOT public.is_staff() THEN
    RAISE EXCEPTION 'staff only';
  END IF;

  IF p_patient_id IS NULL AND p_reg_no IS NULL THEN
    RAISE EXCEPTION 'Provide patient id or reg no';
  END IF;

  SELECT *
  INTO r
  FROM public.patients AS p
  WHERE p.id = public.active_registration_id(p_patient_id, p_reg_no)
  FOR UPDATE;

  IF r.id IS NULL THEN
    RAISE EXCEPTION 'Patient not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.camps AS c WHERE c.id = r.camp_id AND c.is_active
  ) THEN
    RAISE EXCEPTION 'Patient belongs to an inactive camp';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.camp_days AS d
    WHERE d.id = r.camp_day_id
      AND d.printing_open
      AND d.day_date = (timezone('Asia/Kolkata', now()))::date
  ) THEN
    RAISE EXCEPTION 'PRINT_WINDOW_CLOSED';
  END IF;

  IF r.provenance = 'manual_exception'
     AND r.confirmation_override_at IS NULL
     AND EXISTS (
       SELECT 1
       FROM public.persons AS pe
       WHERE pe.id = r.person_id
         AND pe.duplicate_key IS NULL
     )
  THEN
    RAISE EXCEPTION 'AADHAAR_CONFIRMATION_REQUIRED';
  END IF;

  v_already := r.printed_at IS NOT NULL;

  IF NOT v_already THEN
    UPDATE public.patients AS p
    SET printed_at = now(),
        checked_in_by = coalesce(p.checked_in_by, (SELECT auth.uid()))
    WHERE p.id = r.id
    RETURNING p.* INTO r;
  END IF;

  RETURN QUERY
  SELECT r.id, r.reg_no, r.full_name, r.queue_status, v_already;
END;
$function$;

CREATE OR REPLACE FUNCTION public.latest_applied_migration()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$ SELECT '20260816210000'::text $$;
