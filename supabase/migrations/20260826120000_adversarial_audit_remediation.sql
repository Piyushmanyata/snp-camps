CREATE OR REPLACE FUNCTION public.set_camp_day_printing_open(
  p_day_id uuid,
  p_open boolean
)
RETURNS public.camp_days
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  r public.camp_days;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only';
  END IF;
  IF p_day_id IS NULL THEN
    RAISE EXCEPTION 'day id required';
  END IF;

  SELECT *
  INTO r
  FROM public.camp_days AS d
  WHERE d.id = p_day_id
  FOR UPDATE;

  IF r.id IS NULL THEN
    RAISE EXCEPTION 'Day not found';
  END IF;

  IF coalesce(p_open, false)
     AND r.day_date IS DISTINCT FROM (timezone('Asia/Kolkata', now()))::date
  THEN
    RAISE EXCEPTION 'PRINT_WINDOW_NOT_TODAY';
  END IF;

  UPDATE public.camp_days AS d
  SET printing_open = coalesce(p_open, false)
  WHERE d.id = p_day_id
  RETURNING d.* INTO r;

  RETURN r;
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
  v_open boolean;
  v_day_date date;
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

  v_already := r.printed_at IS NOT NULL;
  IF v_already THEN
    RETURN QUERY
    SELECT r.id, r.reg_no, r.full_name, r.queue_status, true;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.camps AS c WHERE c.id = r.camp_id AND c.is_active
  ) THEN
    RAISE EXCEPTION 'Patient belongs to an inactive camp';
  END IF;

  SELECT d.printing_open, d.day_date
  INTO v_open, v_day_date
  FROM public.camp_days AS d
  WHERE d.id = r.camp_day_id
  FOR UPDATE;

  IF v_open IS NOT TRUE
     OR v_day_date IS DISTINCT FROM (timezone('Asia/Kolkata', now()))::date
  THEN
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

  UPDATE public.patients AS p
  SET printed_at = now(),
      checked_in_by = coalesce(p.checked_in_by, (SELECT auth.uid()))
  WHERE p.id = r.id
  RETURNING p.* INTO r;

  RETURN QUERY
  SELECT r.id, r.reg_no, r.full_name, r.queue_status, false;
END;
$function$;

CREATE OR REPLACE FUNCTION public.mark_seen(
  p_patient_id uuid DEFAULT NULL,
  p_reg_no integer DEFAULT NULL
)
RETURNS TABLE(
  id uuid,
  reg_no integer,
  full_name text,
  queue_status public.queue_status,
  seen_at timestamptz,
  seen_by_name text,
  already_seen boolean,
  error_code text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  r public.patients%rowtype;
  v_actor uuid := (SELECT auth.uid());
  v_seen_by_name text;
  v_open boolean;
  v_day_date date;
BEGIN
  IF NOT public.is_staff() THEN
    RAISE EXCEPTION 'staff only';
  END IF;

  SELECT *
  INTO r
  FROM public.patients AS p
  WHERE p.id = public.active_registration_id(p_patient_id, p_reg_no)
  FOR UPDATE;

  IF r.id IS NULL THEN
    RAISE EXCEPTION 'Patient not found';
  END IF;

  IF r.queue_status = 'seen' THEN
    SELECT pf.full_name INTO v_seen_by_name
    FROM public.profiles AS pf
    WHERE pf.id = r.seen_by;

    RETURN QUERY
    SELECT r.id, r.reg_no, r.full_name, r.queue_status,
           r.seen_at, v_seen_by_name, true, 'already_seen'::text;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.camps AS c WHERE c.id = r.camp_id AND c.is_active
  ) THEN
    RAISE EXCEPTION 'Patient belongs to an inactive camp';
  END IF;

  IF r.printed_at IS NULL THEN
    RETURN QUERY
    SELECT r.id, r.reg_no, r.full_name, r.queue_status,
           NULL::timestamptz, NULL::text, false, 'never_printed'::text;
    RETURN;
  END IF;

  SELECT d.printing_open, d.day_date
  INTO v_open, v_day_date
  FROM public.camp_days AS d
  WHERE d.id = r.camp_day_id
  FOR UPDATE;

  IF v_open IS NOT TRUE
     OR v_day_date IS DISTINCT FROM (timezone('Asia/Kolkata', now()))::date
  THEN
    RAISE EXCEPTION 'PRINT_WINDOW_CLOSED';
  END IF;

  UPDATE public.patients AS p
  SET queue_status = 'seen',
      seen_at = now(),
      seen_by = v_actor
  WHERE p.id = r.id
  RETURNING p.* INTO r;

  SELECT pf.full_name INTO v_seen_by_name
  FROM public.profiles AS pf
  WHERE pf.id = r.seen_by;

  RETURN QUERY
  SELECT r.id, r.reg_no, r.full_name, r.queue_status,
         r.seen_at, v_seen_by_name, false, NULL::text;
END;
$function$;

CREATE OR REPLACE FUNCTION public.latest_applied_migration()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$ SELECT '20260826120000'::text $$;

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
  v_stored_age integer;
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

  v_stored_age := CASE
    WHEN p_date_of_birth IS NOT NULL THEN
      GREATEST(0, LEAST(149,
        date_part('year', age((timezone('Asia/Kolkata', now()))::date, p_date_of_birth))::integer
      ))
    ELSE p_age
  END;

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
    v_stored_age,
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
$function$;

CREATE OR REPLACE FUNCTION public.register_patient_idempotent(p_request_id uuid, p_camp_id uuid, p_full_name text, p_gender text, p_age integer, p_address text, p_phone text, p_email text, p_aadhaar_last4 text, p_user_id uuid, p_created_by uuid, p_camp_day_id uuid, p_aadhaar_duplicate_override boolean, p_likely_duplicate_override boolean, p_self_service boolean, p_provenance text, p_duplicate_key text, p_date_of_birth date, p_display_name text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, reg_no integer, full_name text, camp_day_id uuid, day_date date, queue_status queue_status, queued_at timestamp with time zone, checked_in_by uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_provenance text := lower(
    btrim(coalesce(p_provenance, 'self_declared'))
  );
  v_today date := (timezone('Asia/Kolkata', now()))::date;
  v_is_walkin boolean := false;
  v_day public.camp_days%rowtype;
  v_taken integer;
  v_original_limit integer;
  v_result record;
  v_patient public.patients%rowtype;
BEGIN
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
$function$;

CREATE OR REPLACE FUNCTION public.clinical_resolve_item(p_patient_id uuid, p_kind text, p_outcome text, p_unavailable_medicines text[] DEFAULT NULL::text[], p_ot_schedule_day_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_t public.prescription_transcriptions;
  v_item public.fulfilment_items;
  v_camp public.camps%rowtype;
  v_date date;
  v_venue text;
  v_slip public.deferred_slips;
  v_data jsonb;
  v_meds text[];
  v_reason text;
  v_day public.ot_schedule_days;
  v_taken integer;
BEGIN
  IF NOT public.is_clinical_operator() THEN RAISE EXCEPTION 'clinical operator only'; END IF;
  SELECT t.* INTO v_t FROM public.prescription_transcriptions t
    JOIN public.patients p ON p.id=t.patient_id
    JOIN public.camps c ON c.id=p.camp_id
    WHERE p.id=p_patient_id AND p.queue_status='seen' AND c.is_active
    FOR UPDATE OF t;
  IF NOT FOUND THEN RAISE EXCEPTION 'seen transcription required'; END IF;
  SELECT coalesce((
    SELECT c.replacement_data FROM public.prescription_corrections c
    WHERE c.transcription_id=v_t.id AND c.correction_kind='clinical'
    ORDER BY c.created_at DESC LIMIT 1
  ), v_t.data) INTO v_data;
  IF p_kind='medicine' AND p_outcome<>'not_required'
     AND nullif(btrim(v_data->>'medicines'),'') IS NULL
     THEN RAISE EXCEPTION 'medicine detail is required for this outcome'; END IF;
  IF p_kind='specs' AND p_outcome<>'not_required'
     AND (v_data->'specs' IS NULL OR v_data->'specs'='null'::jsonb)
     THEN RAISE EXCEPTION 'Specs measurements are required for this outcome'; END IF;
  IF p_kind='ot' AND p_outcome<>'not_required'
     AND (v_data->'ot' IS NULL OR v_data->'ot'='null'::jsonb)
     THEN RAISE EXCEPTION 'OT detail is required for this outcome'; END IF;

  v_meds := NULL;
  IF p_kind='medicine' AND p_outcome='not_available' THEN
    IF p_unavailable_medicines IS NULL
       OR cardinality(p_unavailable_medicines) NOT BETWEEN 1 AND 12
       OR EXISTS (
         SELECT 1 FROM unnest(p_unavailable_medicines) med
          WHERE med IS NULL OR char_length(btrim(med)) NOT BETWEEN 1 AND 120
       )
    THEN
      RAISE EXCEPTION 'unavailable medicines are required for this outcome';
    END IF;
    SELECT array_agg(btrim(med)) INTO v_meds FROM unnest(p_unavailable_medicines) med;
    v_reason := array_to_string(v_meds, '; ');
  ELSIF p_unavailable_medicines IS NOT NULL THEN
    RAISE EXCEPTION 'unavailable medicines only apply to medicine not_available';
  END IF;

  INSERT INTO public.fulfilment_items(
    transcription_id, kind, outcome, resolved_by, unavailable_medicines
  )
    VALUES(v_t.id, p_kind, p_outcome, v_actor, v_meds)
  ON CONFLICT (transcription_id, kind) DO NOTHING RETURNING * INTO v_item;
  IF v_item.id IS NULL THEN
    SELECT * INTO v_item FROM public.fulfilment_items
      WHERE transcription_id=v_t.id AND kind=p_kind;
    IF v_item.outcome <> p_outcome THEN RAISE EXCEPTION 'outcome conflict'; END IF;
    IF p_kind='ot' AND p_outcome='deferred'
       AND p_ot_schedule_day_id IS DISTINCT FROM v_item.ot_schedule_day_id
    THEN
      RAISE EXCEPTION 'OT_SCHEDULE_CONFLICT';
    END IF;
    IF p_outcome='deferred' THEN
      SELECT * INTO v_slip FROM public.deferred_slips
        WHERE item_id=v_item.id AND status='active';
    END IF;
    RETURN jsonb_build_object('item', to_jsonb(v_item), 'slip', to_jsonb(v_slip));
  ELSE
    UPDATE public.prescription_transcriptions SET locked_at=coalesce(locked_at, now())
      WHERE id=v_t.id;
    INSERT INTO public.fulfilment_events(item_id, event, to_outcome, reason, created_by)
      VALUES(v_item.id, 'resolved', p_outcome, v_reason, v_actor);
  END IF;

  IF p_outcome='deferred' THEN
    SELECT c.* INTO v_camp FROM public.camps c JOIN public.patients p ON p.camp_id=c.id
      WHERE p.id=p_patient_id;
    IF p_kind='specs' THEN
      v_date:=v_camp.spectacles_collection_date; v_venue:=v_camp.spectacles_collection_venue;
    ELSIF p_kind='ot' THEN
      IF p_ot_schedule_day_id IS NOT NULL THEN
        SELECT d.* INTO v_day
        FROM public.ot_schedule_days d
        WHERE d.id = p_ot_schedule_day_id AND d.camp_id = v_camp.id
        FOR UPDATE;
        IF v_day.id IS NULL THEN
          RAISE EXCEPTION 'OT_SCHEDULE_FULL';
        END IF;
        SELECT count(*)::integer INTO v_taken
        FROM public.fulfilment_items i
        WHERE i.ot_schedule_day_id = v_day.id
          AND i.outcome = 'deferred'
          AND i.id IS DISTINCT FROM v_item.id;
        IF v_taken >= v_day.seat_limit THEN
          RAISE EXCEPTION 'OT_SCHEDULE_FULL';
        END IF;
      ELSE
        v_day := NULL;
        FOR v_day IN
          SELECT d.* FROM public.ot_schedule_days d
          WHERE d.camp_id = v_camp.id
          ORDER BY d.day_date, d.id
          FOR UPDATE
        LOOP
          SELECT count(*)::integer INTO v_taken
          FROM public.fulfilment_items i
          WHERE i.ot_schedule_day_id = v_day.id
            AND i.outcome = 'deferred'
            AND i.id IS DISTINCT FROM v_item.id;
          EXIT WHEN v_taken < v_day.seat_limit;
        END LOOP;
        IF v_day.id IS NULL OR v_taken >= v_day.seat_limit THEN
          RAISE EXCEPTION 'OT_SCHEDULE_FULL';
        END IF;
      END IF;
      UPDATE public.fulfilment_items SET ot_schedule_day_id = v_day.id
        WHERE id = v_item.id
        RETURNING * INTO v_item;
      v_date := v_day.day_date;
      v_venue := v_day.venue;
    ELSE
      RAISE EXCEPTION 'medicine cannot be deferred';
    END IF;
    IF v_date IS NULL OR nullif(btrim(v_venue),'') IS NULL THEN
      RAISE EXCEPTION 'matching deferred date and venue are required';
    END IF;
    INSERT INTO public.deferred_slips(item_id, reference, version, service, date_snapshot,
      venue_snapshot, issued_by)
      VALUES(v_item.id, upper(substr(p_kind,1,1))||'-'||substr(replace(v_item.id::text,'-',''),1,10),
        1, p_kind, v_date, v_venue, v_actor)
      ON CONFLICT DO NOTHING RETURNING * INTO v_slip;
    IF v_slip.id IS NULL THEN SELECT * INTO v_slip FROM public.deferred_slips
      WHERE item_id=v_item.id AND status='active'; END IF;
  END IF;
  RETURN jsonb_build_object('item', to_jsonb(v_item), 'slip', to_jsonb(v_slip));
END;
$function$;

CREATE OR REPLACE FUNCTION public.clinical_replace_slip(p_slip_id uuid, p_date date, p_venue text, p_reason text)
 RETURNS deferred_slips
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_old public.deferred_slips;
  v_new public.deferred_slips;
  v_item public.fulfilment_items;
  v_camp_id uuid;
  v_old_day public.ot_schedule_days;
  v_new_day public.ot_schedule_days;
  v_first uuid;
  v_second uuid;
  v_taken integer;
BEGIN
  IF NOT (public.is_clinical_operator() OR public.is_admin()) THEN
    RAISE EXCEPTION 'clinical desk only';
  END IF;
  IF nullif(btrim(p_reason),'') IS NULL OR p_date IS NULL OR nullif(btrim(p_venue),'') IS NULL THEN
    RAISE EXCEPTION 'replacement reason, date, and venue required';
  END IF;
  SELECT * INTO v_old FROM public.deferred_slips WHERE id=p_slip_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active slip not found'; END IF;
  SELECT * INTO v_item FROM public.fulfilment_items WHERE id=v_old.item_id FOR UPDATE;
  SELECT p.camp_id INTO v_camp_id
    FROM public.prescription_transcriptions t
    JOIN public.patients p ON p.id=t.patient_id
   WHERE t.id=v_item.transcription_id;

  IF v_old.service = 'ot' THEN
    SELECT * INTO v_old_day FROM public.ot_schedule_days
      WHERE id = v_item.ot_schedule_day_id;
    SELECT * INTO v_new_day FROM public.ot_schedule_days
      WHERE camp_id = v_camp_id AND day_date = p_date AND venue = p_venue;
    IF v_new_day.id IS NULL THEN
      RAISE EXCEPTION 'OT_SCHEDULE_FULL';
    END IF;
    v_first := LEAST(v_old_day.id, v_new_day.id);
    v_second := GREATEST(v_old_day.id, v_new_day.id);
    IF v_first IS NOT NULL THEN
      PERFORM 1 FROM public.ot_schedule_days WHERE id = v_first FOR UPDATE;
    END IF;
    IF v_second IS NOT NULL AND v_second IS DISTINCT FROM v_first THEN
      PERFORM 1 FROM public.ot_schedule_days WHERE id = v_second FOR UPDATE;
    END IF;
    SELECT count(*)::integer INTO v_taken
      FROM public.fulfilment_items i
     WHERE i.ot_schedule_day_id = v_new_day.id
       AND i.outcome = 'deferred'
       AND i.id IS DISTINCT FROM v_item.id;
    IF v_taken >= v_new_day.seat_limit THEN
      RAISE EXCEPTION 'OT_SCHEDULE_FULL';
    END IF;
    UPDATE public.fulfilment_items
       SET ot_schedule_day_id = v_new_day.id
     WHERE id = v_item.id;
  END IF;

  UPDATE public.deferred_slips SET status='cancelled' WHERE id=v_old.id;
  INSERT INTO public.deferred_slips(item_id,reference,version,service,date_snapshot,
    venue_snapshot,issued_by)
    VALUES(v_old.item_id,v_old.reference,v_old.version+1,v_old.service,p_date,p_venue,v_actor)
    RETURNING * INTO v_new;
  UPDATE public.deferred_slips SET replaced_by=v_new.id WHERE id=v_old.id;
  INSERT INTO public.prescription_corrections(
    transcription_id,reason,replacement_data,created_by,correction_kind
  )
    SELECT i.transcription_id,p_reason,jsonb_build_object('slip_replaced',v_old.id,'replacement',v_new.id,'ot_schedule_day_id',v_new_day.id),v_actor,'slip'
    FROM public.fulfilment_items i WHERE i.id=v_old.item_id;
  RETURN v_new;
END;
$function$;

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
  v_actor uuid := coalesce((SELECT auth.uid()), p_actor_id);
  v_role public.user_role;
  r_patient public.patients%rowtype;
  r_person public.persons%rowtype;
  r_other public.persons%rowtype;
  v_age integer;
BEGIN
  SELECT pr.role INTO v_role
  FROM public.profiles AS pr
  WHERE pr.id = v_actor AND pr.disabled_at IS NULL;

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

  IF NOT EXISTS (
    SELECT 1 FROM public.camps AS c WHERE c.id = r_patient.camp_id AND c.is_active
  ) THEN
    RAISE EXCEPTION 'Patient belongs to an inactive camp';
  END IF;

  SELECT * INTO r_person
  FROM public.persons AS pe
  WHERE pe.id = r_patient.person_id
  FOR UPDATE;

  IF r_person.id IS NULL OR r_person.merged_into IS NOT NULL THEN
    RAISE EXCEPTION 'unrelated registration';
  END IF;

  IF r_patient.provenance IS DISTINCT FROM 'manual_exception'
     OR r_person.duplicate_key IS NOT NULL
     OR r_patient.confirmation_override_at IS NOT NULL
  THEN
    RETURN QUERY SELECT
      'not_required'::text, NULL::integer, NULL::text,
      NULL::integer, NULL::text, NULL::text, NULL::date,
      NULL::text, NULL::text, NULL::text;
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
    SET confirmation_override_actor = v_actor,
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
        date_part('year', age((timezone('Asia/Kolkata', now()))::date, coalesce(r_other.date_of_birth, (timezone('Asia/Kolkata', now()))::date)))::integer,
        r_other.gender, r_person.full_name, r_person.date_of_birth,
        r_person.gender, r_person.aadhaar_last4::text, r_person.address;
    END IF;
    RETURN;
  END IF;

  IF p_mode IS DISTINCT FROM 'commit' THEN
    RAISE EXCEPTION 'invalid confirmation mode';
  END IF;

  v_age := date_part('year', age((timezone('Asia/Kolkata', now()))::date, coalesce(p_date_of_birth, (timezone('Asia/Kolkata', now()))::date)))::integer;

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
        date_part('year', age((timezone('Asia/Kolkata', now()))::date, coalesce(r_other.date_of_birth, p_date_of_birth, (timezone('Asia/Kolkata', now()))::date)))::integer,
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
    date_part('year', age((timezone('Asia/Kolkata', now()))::date, coalesce(r_other.date_of_birth, (timezone('Asia/Kolkata', now()))::date)))::integer,
    r_other.gender, r_person.full_name, r_person.date_of_birth,
    r_person.gender, r_person.aadhaar_last4::text, r_person.address;
END;
$function$;

REVOKE ALL ON FUNCTION public.confirm_manual_exception_aadhaar(
  uuid, text, text, text, date, text, text, text, boolean, uuid, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_manual_exception_aadhaar(
  uuid, text, text, text, date, text, text, text, boolean, uuid, text
) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.readiness_catalog_probe()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v jsonb;
BEGIN
  v := public.readiness_catalog_probe_20260813();
  v := jsonb_set(v, '{functions}', (coalesce(v->'functions', '{}'::jsonb) - 'patient_status_by_token' - 'lookup_patient_status_token') || jsonb_build_object(
    'set_camp_day_printing_open',
    to_regprocedure('public.set_camp_day_printing_open(uuid,boolean)') IS NOT NULL,
    'confirm_manual_exception_aadhaar',
    to_regprocedure('public.confirm_manual_exception_aadhaar(uuid,text,text,text,date,text,text,text,boolean,uuid,text)') IS NOT NULL,
    'upsert_ot_schedule_day',
    to_regprocedure('public.upsert_ot_schedule_day(uuid,date,text,integer,uuid)') IS NOT NULL,
    'list_ot_schedule_days',
    to_regprocedure('public.list_ot_schedule_days(uuid)') IS NOT NULL
  ));
  v := jsonb_set(v, '{tables}', coalesce(v->'tables', '{}'::jsonb) || jsonb_build_object(
    'ot_schedule_days',
    to_regclass('public.ot_schedule_days') IS NOT NULL
  ));
  v := jsonb_set(v, '{columns}', (coalesce(v->'columns', '{}'::jsonb) - 'patients.status_token') || jsonb_build_object(
    'camp_days.printing_open',
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'camp_days' AND column_name = 'printing_open'
    ),
    'persons.address_locked_at',
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'persons' AND column_name = 'address_locked_at'
    ),
    'persons.merged_into',
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'persons' AND column_name = 'merged_into'
    ),
    'patients.confirmation_override_actor',
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'patients' AND column_name = 'confirmation_override_actor'
    ),
    'fulfilment_items.ot_schedule_day_id',
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'fulfilment_items' AND column_name = 'ot_schedule_day_id'
    ),
    'ot_schedule_days.id',
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ot_schedule_days' AND column_name = 'id'
    ),
    'ot_schedule_days.camp_id',
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ot_schedule_days' AND column_name = 'camp_id'
    ),
    'ot_schedule_days.day_date',
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ot_schedule_days' AND column_name = 'day_date'
    ),
    'ot_schedule_days.venue',
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ot_schedule_days' AND column_name = 'venue'
    ),
    'ot_schedule_days.seat_limit',
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ot_schedule_days' AND column_name = 'seat_limit'
    )
  ));
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
      'confirm_manual_exception_aadhaar_authenticated_execute',
      CASE WHEN to_regprocedure('public.confirm_manual_exception_aadhaar(uuid,text,text,text,date,text,text,text,boolean,uuid,text)') IS NOT NULL
        THEN has_function_privilege('authenticated','public.confirm_manual_exception_aadhaar(uuid,text,text,text,date,text,text,text,boolean,uuid,text)','EXECUTE')
        ELSE false END,
      'confirm_manual_exception_aadhaar_anon_execute',
      CASE WHEN to_regprocedure('public.confirm_manual_exception_aadhaar(uuid,text,text,text,date,text,text,text,boolean,uuid,text)') IS NOT NULL
        THEN has_function_privilege('anon','public.confirm_manual_exception_aadhaar(uuid,text,text,text,date,text,text,text,boolean,uuid,text)','EXECUTE')
        ELSE false END,
      'confirm_manual_exception_aadhaar_service_role_execute',
      CASE WHEN to_regprocedure('public.confirm_manual_exception_aadhaar(uuid,text,text,text,date,text,text,text,boolean,uuid,text)') IS NOT NULL
        THEN has_function_privilege('service_role','public.confirm_manual_exception_aadhaar(uuid,text,text,text,date,text,text,text,boolean,uuid,text)','EXECUTE')
        ELSE false END,
      'upsert_ot_schedule_day_authenticated_execute',
      CASE WHEN to_regprocedure('public.upsert_ot_schedule_day(uuid,date,text,integer,uuid)') IS NOT NULL
        THEN has_function_privilege('authenticated','public.upsert_ot_schedule_day(uuid,date,text,integer,uuid)','EXECUTE')
        ELSE false END,
      'upsert_ot_schedule_day_anon_execute',
      CASE WHEN to_regprocedure('public.upsert_ot_schedule_day(uuid,date,text,integer,uuid)') IS NOT NULL
        THEN has_function_privilege('anon','public.upsert_ot_schedule_day(uuid,date,text,integer,uuid)','EXECUTE')
        ELSE false END,
      'list_ot_schedule_days_authenticated_execute',
      CASE WHEN to_regprocedure('public.list_ot_schedule_days(uuid)') IS NOT NULL
        THEN has_function_privilege('authenticated','public.list_ot_schedule_days(uuid)','EXECUTE')
        ELSE false END,
      'list_ot_schedule_days_anon_execute',
      CASE WHEN to_regprocedure('public.list_ot_schedule_days(uuid)') IS NOT NULL
        THEN has_function_privilege('anon','public.list_ot_schedule_days(uuid)','EXECUTE')
        ELSE false END
    )
  );
  v := jsonb_set(
    v,
    '{sms,kinds}',
    coalesce(v#> '{sms,kinds}', '{}'::jsonb) || jsonb_build_object(
      'spectacles_deferral',
      EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typname = 'sms_delivery_kind' AND e.enumlabel = 'spectacles_deferral'
      ),
      'surgery_deferral',
      EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typname = 'sms_delivery_kind' AND e.enumlabel = 'surgery_deferral'
      ),
      'spectacles_deferral_t1',
      EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typname = 'sms_delivery_kind' AND e.enumlabel = 'spectacles_deferral_t1'
      ),
      'surgery_deferral_t1',
      EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typname = 'sms_delivery_kind' AND e.enumlabel = 'surgery_deferral_t1'
      )
    )
  );
  RETURN v;
END;
$function$;
