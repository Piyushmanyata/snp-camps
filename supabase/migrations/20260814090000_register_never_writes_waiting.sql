-- ADR 0013 / 0016 — the insert writer must not stamp waiting or queued_at.
-- 20260813090000 normalised existing waiting rows and patched new ones in
-- register_patient_idempotent after the helper wrote them. The helper is the
-- writer; stop it, then drop the patch.

CREATE OR REPLACE FUNCTION public.register_patient_idempotent_preprint_queue(p_request_id uuid, p_camp_id uuid, p_full_name text, p_gender text, p_age integer, p_address text, p_phone text, p_email text, p_aadhaar_last4 text, p_user_id uuid, p_created_by uuid, p_camp_day_id uuid, p_aadhaar_duplicate_override boolean, p_likely_duplicate_override boolean, p_self_service boolean, p_provenance text, p_duplicate_key text, p_date_of_birth date, p_display_name text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, reg_no integer, full_name text, camp_day_id uuid, day_date date, queue_status queue_status)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_request_role text;
  v_created_by uuid;
  v_aadhaar char(4);
  v_name text;
  v_display_name text;
  v_name_norm text;
  v_phone10 text;
  v_duplicate_key text := nullif(lower(btrim(p_duplicate_key)), '');
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
  v_status public.queue_status;
  v_queued_at timestamptz;
  v_checked_in_by uuid;
  v_soft_lock_keys text[] := array[]::text[];
  v_soft_lock text;
  v_person_id uuid;
  v_person_reg_no integer;
  v_patient_reg_no integer;
  v_out_id uuid;
  v_out_reg_no integer;
  v_out_full_name text;
  v_out_camp_day_id uuid;
  v_out_day_date date;
  v_out_queue_status public.queue_status;
  v_provenance text := lower(
    btrim(coalesce(p_provenance, 'self_declared'))
  );
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'registration request id required';
  END IF;
  IF p_user_id IS NOT NULL THEN
    RAISE EXCEPTION 'patient Auth ownership is retired';
  END IF;

  v_request_role := coalesce(
    nullif(auth.role(), ''),
    nullif(current_setting('request.jwt.claim.role', true), '')
  );

  IF v_request_role = 'service_role' THEN
    IF v_override THEN
      RAISE EXCEPTION 'Aadhaar duplicate override requires staff sign-in';
    END IF;
    IF v_likely_override THEN
      RAISE EXCEPTION 'Likely-duplicate override requires staff sign-in';
    END IF;

    IF coalesce(p_self_service, false) THEN
      IF p_created_by IS NOT NULL THEN
        RAISE EXCEPTION 'self-service registration must not name a staff creator';
      END IF;
      v_created_by := NULL;
    ELSE
      -- service_role is already the trusted backend boundary. It may seed or
      -- recover a manual registration, but a named scanned-card creator must
      -- still be an active desk operator.
      IF v_duplicate_key IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM public.profiles AS p
        WHERE p.id = p_created_by
          AND p.role IN ('admin', 'team_lead', 'volunteer')
          AND p.disabled_at IS NULL
      ) THEN
        RAISE EXCEPTION 'active registration staff member required';
      END IF;
      v_created_by := p_created_by;
    END IF;
  ELSIF v_request_role = 'authenticated' THEN
    IF coalesce(p_self_service, false) THEN
      RAISE EXCEPTION 'self-service registration requires trusted server';
    END IF;
    IF v_duplicate_key IS NOT NULL THEN
      RAISE EXCEPTION 'scanned registration requires trusted server';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM public.profiles AS p
      WHERE p.id = (SELECT auth.uid())
        AND p.role IN ('admin', 'team_lead', 'volunteer')
        AND p.disabled_at IS NULL
    ) THEN
      RAISE EXCEPTION 'active staff member required';
    END IF;
    v_created_by := (SELECT auth.uid());
  ELSE
    RAISE EXCEPTION 'authenticated registration required';
  END IF;

  IF v_duplicate_key IS NOT NULL THEN
    IF v_duplicate_key !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'invalid Person duplicate key';
    END IF;
    IF v_provenance <> 'card_scanned' THEN
      RAISE EXCEPTION 'scanned registration requires card_scanned provenance';
    END IF;
  ELSIF v_provenance <> 'self_declared' THEN
    RAISE EXCEPTION 'manual registration requires self_declared provenance';
  ELSIF coalesce(p_self_service, false) THEN
    RAISE EXCEPTION 'self-service registration requires scanned identity';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext('register-request:' || p_request_id::text)
  );

  SELECT
    p.id,
    p.reg_no,
    coalesce(p.display_name, p.full_name),
    p.camp_day_id,
    d.day_date,
    p.queue_status
  INTO
    v_out_id,
    v_out_reg_no,
    v_out_full_name,
    v_out_camp_day_id,
    v_out_day_date,
    v_out_queue_status
  FROM public.patients AS p
  LEFT JOIN public.camp_days AS d ON d.id = p.camp_day_id
  WHERE p.registration_request_id = p_request_id;

  IF found THEN
    id := v_out_id;
    reg_no := v_out_reg_no;
    full_name := v_out_full_name;
    camp_day_id := v_out_camp_day_id;
    day_date := v_out_day_date;
    queue_status := v_out_queue_status;
    RETURN NEXT;
    RETURN;
  END IF;

  v_name := trim(coalesce(p_full_name, ''));
  IF length(v_name) = 0 OR length(v_name) > 120 THEN
    RAISE EXCEPTION 'full_name required and must be at most 120 characters';
  END IF;
  v_display_name := nullif(trim(coalesce(p_display_name, '')), '');
  v_name_norm := lower(btrim(regexp_replace(v_name, '\s+', ' ', 'g')));

  IF p_age IS NOT NULL AND (p_age < 0 OR p_age >= 150) THEN
    RAISE EXCEPTION 'age must be between 0 and 149';
  END IF;
  IF p_gender IS NOT NULL AND p_gender NOT IN ('M', 'F', 'O') THEN
    RAISE EXCEPTION 'gender must be M, F, or O';
  END IF;

  IF p_aadhaar_last4 IS NULL OR length(trim(p_aadhaar_last4)) = 0 THEN
    v_aadhaar := NULL;
  ELSE
    v_aadhaar := right(regexp_replace(p_aadhaar_last4, '\D', '', 'g'), 4);
    IF v_aadhaar !~ '^[0-9]{4}$' THEN
      RAISE EXCEPTION 'Invalid aadhaar last4';
    END IF;
  END IF;

  IF v_duplicate_key IS NOT NULL THEN
    IF v_aadhaar IS NULL
       OR p_date_of_birth IS NULL
       OR p_gender NOT IN ('M', 'F', 'O')
    THEN
      RAISE EXCEPTION
        'scanned identity requires Aadhaar last4, date of birth, and gender';
    END IF;
  END IF;

  v_phone10 := nullif(
    right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10),
    ''
  );
  IF v_phone10 IS NOT NULL AND length(v_phone10) < 10 THEN
    v_phone10 := NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.camps AS c
    WHERE c.id = p_camp_id
      AND c.is_active
  ) THEN
    RAISE EXCEPTION 'No active camp';
  END IF;

  -- Card identity is the idempotency key across retries and Camp visits.
  -- Resolve an existing registration before checking capacity, so a retry
  -- remains successful even after the selected day fills.
  IF v_duplicate_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtext('person-duplicate-key:' || v_duplicate_key)
    );

    SELECT pe.id, pe.reg_no
    INTO v_person_id, v_person_reg_no
    FROM public.persons AS pe
    WHERE pe.duplicate_key = v_duplicate_key;

    IF v_person_id IS NOT NULL THEN
      SELECT
        p.id,
        p.reg_no,
        coalesce(p.display_name, p.full_name),
        p.camp_day_id,
        d.day_date,
        p.queue_status
      INTO
        v_out_id,
        v_out_reg_no,
        v_out_full_name,
        v_out_camp_day_id,
        v_out_day_date,
        v_out_queue_status
      FROM public.patients AS p
      JOIN public.camp_days AS d ON d.id = p.camp_day_id
      WHERE p.camp_id = p_camp_id
        AND p.person_id = v_person_id
      LIMIT 1;

      IF found THEN
        id := v_out_id;
        reg_no := v_out_reg_no;
        full_name := v_out_full_name;
        camp_day_id := v_out_camp_day_id;
        day_date := v_out_day_date;
        queue_status := v_out_queue_status;
        RETURN NEXT;
        RETURN;
      END IF;
    END IF;
  END IF;

  IF p_camp_day_id IS NULL THEN
    RAISE EXCEPTION 'Please select a camp day';
  END IF;

  SELECT *
  INTO v_day
  FROM public.camp_days AS d
  WHERE d.id = p_camp_day_id
  FOR UPDATE;

  IF v_day.id IS NULL OR v_day.camp_id IS DISTINCT FROM p_camp_id THEN
    RAISE EXCEPTION 'Invalid camp day';
  END IF;

  SELECT count(*)::integer
  INTO v_taken
  FROM public.patients AS p
  WHERE p.camp_day_id = p_camp_day_id;

  v_today := (timezone('Asia/Kolkata', now()))::date;
  -- Seat caps apply to pre-registration only (self-service or non-today days).
  -- Desk walk-ins on today are never turned away for capacity (CONTEXT).
  IF v_taken >= v_day.seat_limit
     AND (
       coalesce(p_self_service, false)
       OR v_day.day_date IS DISTINCT FROM v_today
     )
  THEN
    RAISE EXCEPTION
      'This day is full (% seats). Choose another day.',
      v_day.seat_limit;
  END IF;
  v_status := 'registered';
  v_queued_at := NULL;
  v_checked_in_by := NULL;

  IF v_duplicate_key IS NOT NULL THEN
    IF v_person_id IS NULL THEN
      INSERT INTO public.persons (
        reg_no,
        full_name,
        display_name,
        gender,
        date_of_birth,
        address,
        phone,
        email,
        aadhaar_last4,
        duplicate_key,
        aadhaar_locked_at,
        name_locked_at,
        created_by,
        created_at
      ) VALUES (
        nextval('public.patient_reg_no_seq'::regclass),
        v_name,
        v_display_name,
        p_gender,
        p_date_of_birth,
        nullif(trim(coalesce(p_address, '')), ''),
        v_phone10,
        nullif(trim(coalesce(p_email, '')), ''),
        v_aadhaar,
        v_duplicate_key,
        now(),
        now(),
        v_created_by,
        now()
      )
      RETURNING public.persons.id, public.persons.reg_no
      INTO v_person_id, v_person_reg_no;
    END IF;
  ELSE
    IF p_age IS NOT NULL THEN
      v_soft_lock_keys := array_append(
        v_soft_lock_keys,
        'name-age:' || p_camp_id::text || ':' || v_name_norm || ':' || p_age::text
      );
    END IF;

    IF coalesce(array_length(v_soft_lock_keys, 1), 0) > 0 THEN
      SELECT coalesce(array_agg(k ORDER BY k), array[]::text[])
      INTO v_soft_lock_keys
      FROM unnest(v_soft_lock_keys) AS k;

      FOREACH v_soft_lock IN ARRAY v_soft_lock_keys
      LOOP
        PERFORM pg_advisory_xact_lock(
          hashtext('snp-reg-likely-dup'),
          hashtext(v_soft_lock)
        );
      END LOOP;
    END IF;

    SELECT p.reg_no
    INTO v_soft_reg
    FROM public.patients AS p
    WHERE p.camp_id = p_camp_id
      AND p_age IS NOT NULL
      AND p.age IS NOT NULL
      AND p.full_name_normalized = v_name_norm
      AND p.age = p_age
    ORDER BY p.reg_no
    LIMIT 1;

    IF v_soft_reg IS NOT NULL THEN
      IF NOT v_likely_override THEN
        RAISE EXCEPTION 'LIKELY_DUPLICATE:reg=%', v_soft_reg;
      END IF;
      IF v_request_role IS DISTINCT FROM 'authenticated' THEN
        RAISE EXCEPTION 'Likely-duplicate override requires staff sign-in';
      END IF;
      v_likely_by := (SELECT auth.uid());
      v_likely_at := now();
    END IF;

    IF v_aadhaar IS NOT NULL THEN
      SELECT p.reg_no
      INTO v_conflict_reg
      FROM public.patients AS p
      WHERE p.camp_id = p_camp_id
        AND p.aadhaar_last4 = v_aadhaar
        AND p.full_name_normalized = v_name_norm
        AND p.aadhaar_duplicate_override_at IS NULL
      LIMIT 1;

      IF v_conflict_reg IS NOT NULL THEN
        IF NOT v_override THEN
          RAISE EXCEPTION 'AADHAAR_DUPLICATE:reg=%', v_conflict_reg;
        END IF;
        IF v_request_role IS DISTINCT FROM 'authenticated' THEN
          RAISE EXCEPTION 'Aadhaar duplicate override requires staff sign-in';
        END IF;
        v_override_by := (SELECT auth.uid());
        v_override_at := now();
      END IF;
    END IF;
  END IF;

  v_patient_reg_no := coalesce(
    v_person_reg_no,
    nextval('public.patient_reg_no_seq'::regclass)
  );

  INSERT INTO public.patients (
    registration_request_id,
    camp_id,
    camp_day_id,
    person_id,
    reg_no,
    full_name,
    display_name,
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
    likely_duplicate_override_at,
    provenance
  ) VALUES (
    p_request_id,
    p_camp_id,
    p_camp_day_id,
    v_person_id,
    v_patient_reg_no,
    v_name,
    v_display_name,
    p_gender,
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
    v_likely_at,
    v_provenance
  )
  RETURNING public.patients.* INTO v_row;

  IF v_phone10 IS NOT NULL AND NOT coalesce(p_self_service, false) THEN
    INSERT INTO public.sms_deliveries (
      patient_id,
      kind,
      state,
      phone_last4
    ) VALUES (
      v_row.id,
      'registration',
      'pending',
      right(v_phone10, 4)::char(4)
    )
    ON CONFLICT (patient_id, kind) DO NOTHING;
  END IF;

  id := v_row.id;
  reg_no := v_row.reg_no;
  full_name := coalesce(v_row.display_name, v_row.full_name);
  camp_day_id := v_row.camp_day_id;
  day_date := v_day.day_date;
  queue_status := v_row.queue_status;
  RETURN NEXT;
END;
$function$
;

REVOKE ALL ON FUNCTION public.register_patient_idempotent_preprint_queue(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, boolean, text, text, date, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_patient_idempotent_preprint_queue(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, boolean, text, text, date, text
) TO service_role, postgres;

CREATE OR REPLACE FUNCTION public.register_patient_idempotent(p_request_id uuid, p_camp_id uuid, p_full_name text, p_gender text, p_age integer, p_address text, p_phone text, p_email text, p_aadhaar_last4 text, p_user_id uuid, p_created_by uuid, p_camp_day_id uuid, p_aadhaar_duplicate_override boolean, p_likely_duplicate_override boolean, p_self_service boolean, p_provenance text, p_duplicate_key text, p_date_of_birth date, p_display_name text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, reg_no integer, full_name text, camp_day_id uuid, day_date date, queue_status queue_status, queued_at timestamp with time zone, checked_in_by uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
-- requires card_scanned provenance
DECLARE
  v_provenance text := lower(
    btrim(coalesce(p_provenance, 'self_declared'))
  );
  v_existing_request boolean;
  v_today date := (timezone('Asia/Kolkata', now()))::date;
  v_is_walkin boolean := false;
  v_day public.camp_days%rowtype;
  v_taken integer;
  v_original_limit integer;
  v_result record;
  v_patient public.patients%rowtype;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM public.patients AS p
    WHERE p.registration_request_id = p_request_id
  )
  INTO v_existing_request;

  IF p_camp_day_id IS NOT NULL THEN
    SELECT *
    INTO v_day
    FROM public.camp_days AS d
    WHERE d.id = p_camp_day_id
      AND d.camp_id = p_camp_id
    FOR UPDATE;

    IF v_day.id IS NOT NULL THEN
      SELECT count(*)::integer
      INTO v_taken
      FROM public.patients AS p
      WHERE p.camp_day_id = p_camp_day_id;

      v_is_walkin :=
        v_day.day_date = v_today
        AND NOT coalesce(p_self_service, false);

      IF v_is_walkin AND v_taken >= v_day.seat_limit THEN
        v_original_limit := v_day.seat_limit;
        UPDATE public.camp_days
        SET seat_limit = v_taken + 1
        WHERE camp_days.id = p_camp_day_id;
      END IF;
    END IF;
  END IF;

  BEGIN
    SELECT r.*
    INTO v_result
    FROM public.register_patient_idempotent_preprint_queue(
      p_request_id,
      p_camp_id,
      p_full_name,
      p_gender,
      p_age,
      p_address,
      p_phone,
      p_email,
      p_aadhaar_last4,
      p_user_id,
      p_created_by,
      p_camp_day_id,
      p_aadhaar_duplicate_override,
      p_likely_duplicate_override,
      p_self_service,
      v_provenance,
      p_duplicate_key,
      p_date_of_birth,
      p_display_name
    ) AS r;
  EXCEPTION WHEN OTHERS THEN
    IF v_original_limit IS NOT NULL THEN
      UPDATE public.camp_days
      SET seat_limit = v_original_limit
      WHERE camp_days.id = p_camp_day_id;
    END IF;
    RAISE;
  END;

  IF v_original_limit IS NOT NULL THEN
    UPDATE public.camp_days
    SET seat_limit = v_original_limit
    WHERE camp_days.id = p_camp_day_id;
  END IF;

  IF v_result.id IS NULL THEN
    RAISE EXCEPTION 'Registration did not return a patient';
  END IF;

  SELECT pt.*
  INTO v_patient
  FROM public.patients AS pt
  WHERE pt.id = v_result.id;

  RETURN QUERY
  SELECT v_patient.id,
    v_patient.reg_no,
    coalesce(v_patient.display_name, v_patient.full_name),
    v_patient.camp_day_id,
    v_result.day_date,
    v_patient.queue_status,
    v_patient.queued_at,
    v_patient.checked_in_by;
END;
$function$
;

REVOKE ALL ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, boolean, text, text, date, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, boolean, text, text, date, text
) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.latest_applied_migration()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$ SELECT '20260814090000'::text $$;

ALTER FUNCTION public.latest_applied_migration() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.latest_applied_migration() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.latest_applied_migration() TO service_role, postgres;
