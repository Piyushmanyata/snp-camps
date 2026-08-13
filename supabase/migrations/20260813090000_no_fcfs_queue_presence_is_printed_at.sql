-- ADR 0013 — there is no FCFS Queue. Lifecycle is registered -> seen and
-- presence is printed_at. Print prescription records presence once; it never
-- changes queue_status and never writes queued_at.
--
-- Append-only incremental migration. `waiting` stays on the queue_status enum
-- because Postgres cannot drop an enum value; the app treats it as dead, the
-- same way `doctor` is dead on user_role.
--
-- Signature and return-type changes below use explicit DROP + CREATE + re-grant
-- (AGENTS.md, Postgres): CREATE OR REPLACE cannot change a return type, and a
-- changed argument list forks a second overload instead of replacing the first.

-- ---------------------------------------------------------------------------
-- 1. One-time normalisation. Residual `waiting` rows are not a line: they are
--    registrations that were printed for. Move them to `registered` and keep
--    their arrival as presence. queued_at is left untouched as history.
--    Irreversible for the queue_status column — see ADR 0016.
-- ---------------------------------------------------------------------------

UPDATE public.patients
SET queue_status = 'registered',
    printed_at = coalesce(printed_at, queued_at)
WHERE queue_status = 'waiting';

-- ---------------------------------------------------------------------------
-- 2. Registration never records presence. The seat_limit raise-and-restore
--    above this guard is a capacity protection and is deliberately untouched;
--    only the condition on the normalising UPDATE changes, so a walk-in on a
--    day with seats left no longer inherits `waiting` from the legacy
--    pre-print implementation.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.register_patient_idempotent(
  p_request_id uuid,
  p_camp_id uuid,
  p_full_name text,
  p_gender text,
  p_age integer,
  p_address text,
  p_phone text,
  p_email text,
  p_aadhaar_last4 text,
  p_user_id uuid,
  p_created_by uuid,
  p_camp_day_id uuid,
  p_aadhaar_duplicate_override boolean,
  p_likely_duplicate_override boolean,
  p_self_service boolean,
  p_provenance text,
  p_duplicate_key text,
  p_date_of_birth date,
  p_display_name text DEFAULT NULL::text
)
RETURNS TABLE(
  id uuid,
  reg_no integer,
  full_name text,
  camp_day_id uuid,
  day_date date,
  queue_status public.queue_status,
  queued_at timestamptz,
  checked_in_by uuid
)
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

  -- Registration is not presence. Only a row this request created is reset:
  -- a retry or a Person-level duplicate return keeps its established state.
  IF NOT v_existing_request THEN
    UPDATE public.patients AS p
    SET queue_status = 'registered',
        queued_at = NULL,
        checked_in_by = NULL
    WHERE p.registration_request_id = p_request_id
      AND p.id = v_result.id;
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

-- ---------------------------------------------------------------------------
-- 3. Print prescription — the single presence writer. The argument list gains
--    p_reg_no so the scan path, the sheet, register-and-print and the
--    likely-duplicate print all resolve the same way; the old (uuid) overload
--    is dropped explicitly so it cannot survive alongside the new one.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.mark_patient_printed(uuid);
DROP FUNCTION IF EXISTS public.check_in_patient(uuid, integer);
DROP FUNCTION IF EXISTS public.check_in_patient_registration_impl(uuid, integer);
DROP FUNCTION IF EXISTS public.desk_waiting_queue(uuid, integer);

CREATE FUNCTION public.mark_patient_printed(
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

  v_already := r.printed_at IS NOT NULL;

  -- Presence is recorded once. A reprint — including for a seen patient —
  -- keeps the original printed_at so it never looks like a second arrival.
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

ALTER FUNCTION public.mark_patient_printed(uuid, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mark_patient_printed(uuid, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_patient_printed(uuid, integer)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.mark_patient_printed(uuid, integer) IS
  'Print prescription: records presence (printed_at) once. Never writes queue_status or queued_at (ADR 0013).';

-- ---------------------------------------------------------------------------
-- 4. Mark seen gates on presence, not on a queue state. That is what lets a
--    row left over from the old line be marked seen without a special case.
-- ---------------------------------------------------------------------------

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

  IF NOT EXISTS (
    SELECT 1 FROM public.camps AS c WHERE c.id = r.camp_id AND c.is_active
  ) THEN
    RAISE EXCEPTION 'Patient belongs to an inactive camp';
  END IF;

  -- Already seen is a successful, idempotent terminal outcome. Never re-stamp
  -- seen_at or reattribute seen_by — a double scan must not rewrite history.
  IF r.queue_status = 'seen' THEN
    SELECT pf.full_name INTO v_seen_by_name
    FROM public.profiles AS pf
    WHERE pf.id = r.seen_by;

    RETURN QUERY
    SELECT r.id, r.reg_no, r.full_name, r.queue_status,
           r.seen_at, v_seen_by_name, true, 'already_seen'::text;
    RETURN;
  END IF;

  IF r.printed_at IS NULL THEN
    RETURN QUERY
    SELECT r.id, r.reg_no, r.full_name, r.queue_status,
           NULL::timestamptz, NULL::text, false, 'never_printed'::text;
    RETURN;
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

COMMENT ON FUNCTION public.mark_seen(uuid, integer) IS
  'Mark seen: refuses a never-printed Registration with error_code never_printed (ADR 0013).';

-- ---------------------------------------------------------------------------
-- 5. Undo returns to `registered` and keeps presence, so the patient can be
--    marked seen again without reprinting the paper.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.undo_mark_seen(p_patient_id uuid)
RETURNS TABLE(
  id uuid,
  reg_no integer,
  full_name text,
  queue_status public.queue_status,
  error_code text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  r public.patients%rowtype;
  v_active boolean;
BEGIN
  IF NOT public.is_staff() THEN
    RAISE EXCEPTION 'staff only';
  END IF;

  SELECT * INTO r
  FROM public.patients AS p
  WHERE p.id = p_patient_id
  FOR UPDATE;

  IF r.id IS NULL THEN
    RAISE EXCEPTION 'Patient not found';
  END IF;

  SELECT c.is_active INTO v_active
  FROM public.camps AS c
  WHERE c.id = r.camp_id
  FOR UPDATE;

  IF v_active IS DISTINCT FROM true THEN
    RETURN QUERY
    SELECT r.id, r.reg_no, r.full_name, r.queue_status, 'inactive_camp'::text;
    RETURN;
  END IF;

  IF r.queue_status IS DISTINCT FROM 'seen' THEN
    RETURN QUERY
    SELECT r.id, r.reg_no, r.full_name, r.queue_status, 'not_seen'::text;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.prescription_transcriptions AS pt
    WHERE pt.patient_id = r.id
  ) THEN
    RETURN QUERY
    SELECT r.id, r.reg_no, r.full_name, r.queue_status, 'clinical_started'::text;
    RETURN;
  END IF;

  IF r.seen_at IS NULL OR r.seen_at < now() - interval '10 minutes' THEN
    RETURN QUERY
    SELECT r.id, r.reg_no, r.full_name, r.queue_status,
           'undo_window_expired'::text;
    RETURN;
  END IF;

  UPDATE public.patients AS p
  SET queue_status = 'registered',
      seen_at = NULL,
      seen_by = NULL
  WHERE p.id = r.id
  RETURNING p.* INTO r;

  RETURN QUERY
  SELECT r.id, r.reg_no, r.full_name, r.queue_status, NULL::text;
END;
$function$;

COMMENT ON FUNCTION public.undo_mark_seen(uuid) IS
  'Undo mark seen within ten minutes: restores registered and keeps printed_at (ADR 0013).';

-- ---------------------------------------------------------------------------
-- 6. Public status bearer. The position column is removed from the return
--    type, so DROP + CREATE + re-grant rather than CREATE OR REPLACE.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.patient_status_by_token(text);

CREATE FUNCTION public.patient_status_by_token(p_token text)
RETURNS TABLE(
  reg_no integer,
  queue_status public.queue_status,
  camp_name text,
  venue text,
  day_date date,
  patient_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_token text;
  v_id uuid;
  v_camp_id uuid;
  v_reg_no integer;
  v_status public.queue_status;
  v_camp_day_id uuid;
BEGIN
  v_token := lower(btrim(coalesce(p_token, '')));
  IF v_token = '' OR v_token !~ '^[0-9a-f]{32}$' THEN
    RETURN;
  END IF;

  SELECT p.id, p.camp_id, p.reg_no, p.queue_status, p.camp_day_id
  INTO v_id, v_camp_id, v_reg_no, v_status, v_camp_day_id
  FROM public.patients AS p
  WHERE p.status_token = v_token;

  IF v_id IS NULL THEN
    RETURN;
  END IF;

  reg_no := v_reg_no;
  queue_status := v_status;
  patient_id := v_id;

  SELECT c.name, coalesce(c.venue, '—')
  INTO camp_name, venue
  FROM public.camps AS c
  WHERE c.id = v_camp_id;

  IF camp_name IS NULL THEN
    camp_name := '—';
    venue := '—';
  END IF;

  IF v_camp_day_id IS NOT NULL THEN
    SELECT d.day_date INTO day_date
    FROM public.camp_days AS d
    WHERE d.id = v_camp_day_id;
  END IF;

  RETURN NEXT;
END;
$function$;

ALTER FUNCTION public.patient_status_by_token(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.patient_status_by_token(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.patient_status_by_token(text)
  TO service_role, postgres;

COMMENT ON FUNCTION public.patient_status_by_token(text) IS
  'PII-free bearer status projection: registration, registered/seen, camp/day, venue, and staff-scan patient id. No position (ADR 0013).';

-- ---------------------------------------------------------------------------
-- 7. Staff KPIs stop reporting a dead state. Removing the waiting column is a
--    return-type change, so DROP + CREATE + re-grant.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.staff_person_kpis(uuid, text, uuid, text);

CREATE FUNCTION public.staff_person_kpis(
  p_user_id uuid,
  p_role text,
  p_camp_id uuid DEFAULT NULL::uuid,
  p_scope text DEFAULT 'person'::text
)
RETURNS TABLE(
  total bigint,
  today bigint,
  seen bigint,
  label text,
  staff_id uuid,
  full_name text,
  staff_role public.user_role,
  distinct_patients integer,
  team_lead_id uuid,
  team_headcount integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_caller uuid := (SELECT auth.uid());
  v_caller_role public.user_role;
  v_target_role public.user_role;
  v_camp_id uuid;
  v_total bigint := 0;
  v_seen bigint := 0;
  v_headcount integer := 0;
BEGIN
  SELECT pf.role INTO v_caller_role
  FROM public.profiles AS pf
  WHERE pf.id = v_caller AND pf.disabled_at IS NULL;

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'team_lead', 'volunteer') THEN
    RAISE EXCEPTION 'active camp crew required';
  END IF;

  IF p_scope = 'leaderboard' THEN
    IF p_user_id IS NOT NULL OR p_role IS NOT NULL THEN
      RAISE EXCEPTION 'leaderboard target forbidden';
    END IF;

    SELECT c.id INTO v_camp_id FROM public.camps AS c
    WHERE c.id = p_camp_id AND c.is_active;

    RETURN QUERY
    WITH active_profiles AS (
      SELECT pf.id, pf.full_name, pf.role, pf.team_lead_id
      FROM public.profiles pf
      WHERE pf.disabled_at IS NULL
        AND pf.role IN ('team_lead', 'volunteer')
    ),
    roster AS (
      SELECT ap.id AS r_id, ap.full_name AS r_name,
        ap.role AS r_role, ap.team_lead_id AS r_lead,
        CASE WHEN v_camp_id IS NULL THEN 0
             WHEN ap.role = 'team_lead' THEN (
               SELECT count(DISTINCT x.id)::integer
               FROM public.patients x
               WHERE x.camp_id = v_camp_id
                 AND x.provenance IS DISTINCT FROM 'manual_exception'
                 AND x.created_by IN (
                   SELECT m.id FROM active_profiles m
                   WHERE m.id = ap.id OR (m.role = 'volunteer' AND m.team_lead_id = ap.id)
                 )
             )
             ELSE (
               SELECT count(DISTINCT x.id)::integer
               FROM public.patients x
               WHERE x.camp_id = v_camp_id
                 AND x.provenance IS DISTINCT FROM 'manual_exception'
                 AND x.created_by = ap.id
             )
        END AS registered_count,
        CASE WHEN v_camp_id IS NULL THEN 0
             WHEN ap.role = 'team_lead' THEN (
               SELECT count(DISTINCT x.id)::integer
               FROM public.patients x
               WHERE x.camp_id = v_camp_id
                 AND x.provenance IS DISTINCT FROM 'manual_exception'
                 AND x.queue_status = 'seen'
                 AND x.created_by IN (
                   SELECT m.id FROM active_profiles m
                   WHERE m.id = ap.id OR (m.role = 'volunteer' AND m.team_lead_id = ap.id)
                 )
             )
             ELSE (
               SELECT count(DISTINCT x.id)::integer
               FROM public.patients x
               WHERE x.camp_id = v_camp_id
                 AND x.provenance IS DISTINCT FROM 'manual_exception'
                 AND x.queue_status = 'seen'
                 AND x.created_by = ap.id
             )
        END AS seen_count,
        CASE WHEN ap.role = 'team_lead' THEN (
          SELECT count(*)::integer
          FROM active_profiles member
          WHERE member.team_lead_id = ap.id
            AND member.role = 'volunteer'
        ) ELSE 0 END AS headcount
      FROM active_profiles ap
    )
    SELECT
      roster.registered_count::bigint,
      0::bigint,
      roster.seen_count::bigint,
      'Registered'::text,
      roster.r_id,
      roster.r_name,
      roster.r_role,
      roster.registered_count,
      roster.r_lead,
      roster.headcount
    FROM roster
    ORDER BY roster.registered_count DESC, roster.r_name NULLS LAST, roster.r_id;
    RETURN;
  END IF;

  IF p_scope <> 'person' OR p_user_id IS NULL OR p_role IS NULL
     OR p_role NOT IN ('volunteer', 'team_lead') THEN
    RAISE EXCEPTION 'invalid KPI target';
  END IF;

  SELECT pf.role INTO v_target_role
  FROM public.profiles AS pf
  WHERE pf.id = p_user_id AND pf.disabled_at IS NULL;
  IF v_target_role IS NULL OR v_target_role::text <> p_role THEN
    RAISE EXCEPTION 'invalid KPI target';
  END IF;

  IF v_caller_role <> 'admin' AND v_caller <> p_user_id
     AND NOT (
       v_caller_role = 'team_lead'
       AND v_target_role = 'volunteer'
       AND EXISTS (
         SELECT 1 FROM public.profiles member
         WHERE member.id = p_user_id
           AND member.team_lead_id = v_caller
           AND member.disabled_at IS NULL
       )
     ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT c.id INTO v_camp_id FROM public.camps AS c
  WHERE c.id = p_camp_id AND c.is_active;

  SELECT count(*)::integer INTO v_headcount
  FROM public.profiles member
  WHERE member.team_lead_id = p_user_id
    AND member.role = 'volunteer'
    AND member.disabled_at IS NULL;

  IF v_target_role = 'team_lead' THEN
    RETURN QUERY
    WITH team_members AS (
      SELECT p_user_id AS member_id
      UNION
      SELECT member.id
      FROM public.profiles AS member
      WHERE member.role = 'volunteer'
        AND member.team_lead_id = p_user_id
        AND member.disabled_at IS NULL
    )
    SELECT
      count(DISTINCT pt.id)::bigint,
      0::bigint,
      count(DISTINCT pt.id) FILTER (WHERE pt.queue_status = 'seen')::bigint,
      'Registered'::text,
      p_user_id,
      profile.full_name,
      profile.role,
      count(DISTINCT pt.id)::integer,
      profile.team_lead_id,
      v_headcount
    FROM public.profiles AS profile
    LEFT JOIN public.patients AS pt
      ON pt.camp_id = v_camp_id
     AND pt.provenance IS DISTINCT FROM 'manual_exception'
     AND pt.created_by IN (SELECT member_id FROM team_members)
    WHERE profile.id = p_user_id
    GROUP BY profile.full_name, profile.role, profile.team_lead_id;
  ELSE
    SELECT count(*)::bigint,
      count(*) FILTER (WHERE pt.queue_status = 'seen')::bigint
    INTO v_total, v_seen
    FROM public.patients pt
    WHERE pt.camp_id = v_camp_id
      AND pt.created_by = p_user_id
      AND pt.provenance IS DISTINCT FROM 'manual_exception';

    RETURN QUERY
    SELECT v_total, 0::bigint, v_seen,
      'Registered'::text, p_user_id, profile.full_name, profile.role,
      v_total::integer, profile.team_lead_id, v_headcount
    FROM public.profiles profile
    WHERE profile.id = p_user_id;
  END IF;
END;
$function$;

ALTER FUNCTION public.staff_person_kpis(uuid, text, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.staff_person_kpis(uuid, text, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_person_kpis(uuid, text, uuid, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.staff_person_kpis(uuid, text, uuid, text) IS
  'Staff KPI contract: registered / seen only. No waiting count — there is no line (ADR 0013).';

-- ---------------------------------------------------------------------------
-- 8. Admin analytics stop reporting queue depth and wait percentiles. Both
--    derive from queued_at, which nothing writes once presence is printed_at,
--    so leaving them would ship a dashboard of permanent zeros.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.camp_queue_counts(uuid);

CREATE FUNCTION public.camp_queue_counts(p_camp_id uuid)
RETURNS TABLE(
  registered_count bigint,
  seen_count bigint,
  total_count bigint,
  completed_today_count bigint,
  desk_registration_count bigint,
  self_registration_count bigint,
  scanned_registration_count bigint,
  self_declared_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH scoped AS (
    SELECT p.queue_status, p.seen_at, p.created_by, p.provenance
    FROM public.patients AS p
    JOIN public.camps AS c
      ON c.id = p.camp_id
     AND c.is_active = true
    WHERE p.camp_id = p_camp_id
  )
  SELECT
    count(*) FILTER (
      WHERE s.queue_status = 'registered'::public.queue_status
    )::bigint,
    count(*) FILTER (
      WHERE s.queue_status = 'seen'::public.queue_status
    )::bigint,
    count(*)::bigint,
    count(*) FILTER (
      WHERE s.queue_status = 'seen'::public.queue_status
        AND s.seen_at IS NOT NULL
        AND (timezone('Asia/Kolkata', s.seen_at))::date =
            (timezone('Asia/Kolkata', now()))::date
    )::bigint,
    count(*) FILTER (WHERE s.created_by IS NOT NULL)::bigint,
    count(*) FILTER (WHERE s.created_by IS NULL)::bigint,
    count(*) FILTER (WHERE s.provenance = 'card_scanned')::bigint,
    count(*) FILTER (WHERE s.provenance = 'self_declared')::bigint
  FROM scoped AS s;
END;
$function$;

ALTER FUNCTION public.camp_queue_counts(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.camp_queue_counts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.camp_queue_counts(uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.camp_queue_counts(uuid) IS
  'Admin camp rollup: registered / seen / provenance. No queue depth or wait percentiles (ADR 0013).';

-- ---------------------------------------------------------------------------
-- 9. Readiness contract. check_in_patient and desk_waiting_queue no longer
--    exist, so the probe must stop requiring them and must require the new
--    mark_patient_printed signature instead. The probe body is otherwise
--    identical to 20260812090000.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.latest_applied_migration()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$ SELECT '20260813090000'::text $$;

ALTER FUNCTION public.latest_applied_migration() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.latest_applied_migration() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.latest_applied_migration() TO service_role, postgres;

CREATE OR REPLACE FUNCTION public.readiness_catalog_probe()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_tables jsonb;
  v_columns jsonb;
  v_functions jsonb;
  v_invariants jsonb;
  v_grants jsonb;
  v_states jsonb;
  v_kinds jsonb;
  v_clinical_signatures text[] := ARRAY[
    'public.is_clinical_operator()',
    'public.clinical_lookup(uuid,integer)',
    'public.clinical_save_transcription(uuid,jsonb)',
    'public.clinical_add_correction(uuid,jsonb,text)',
    'public.clinical_resolve_item(uuid,text,text,text[])',
    'public.clinical_followup_fulfil(uuid)',
    'public.clinical_followup_lookup(uuid,integer)',
    'public.clinical_slip_by_id(uuid)',
    'public.clinical_replace_slip(uuid,date,text,text)',
    'public.admin_prescription_template_editor(uuid)',
    'public.admin_save_prescription_template(uuid,jsonb,boolean)',
    'public.admin_clinical_records(uuid,boolean,integer,integer)',
    'public.admin_archive_transcription(uuid,boolean)',
    'public.admin_reverse_fulfilment(uuid,text)',
    'public.published_prescription_template(uuid)'
  ];
BEGIN
  SELECT jsonb_object_agg(expected.name, to_regclass('public.' || expected.name) IS NOT NULL)
  INTO v_tables
  FROM (VALUES
    ('patients'), ('persons'), ('camps'), ('camp_days'), ('profiles'),
    ('sms_deliveries'), ('public_rate_limit_buckets'),
    ('prescription_transcriptions'), ('prescription_corrections'),
    ('fulfilment_items'), ('fulfilment_events'), ('deferred_slips'),
    ('prescription_template_versions'), ('sponsor_assets'),
    ('aadhaar_extraction_events')
  ) AS expected(name);

  SELECT jsonb_object_agg(expected.table_name || '.' || expected.column_name,
    EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = expected.table_name
        AND c.column_name = expected.column_name
    ))
  INTO v_columns
  FROM (VALUES
    ('patients','id'), ('patients','status_token'), ('patients','queue_status'),
    ('patients','queued_at'), ('patients','printed_at'), ('patients','seen_at'),
    ('patients','seen_by'), ('patients','reg_no'), ('patients','camp_id'),
    ('patients','camp_day_id'), ('patients','full_name'), ('patients','display_name'),
    ('patients','person_id'), ('patients','provenance'), ('patients','phone_provenance'),
    ('persons','id'), ('persons','reg_no'), ('persons','full_name'),
    ('persons','display_name'), ('persons','gender'), ('persons','date_of_birth'),
    ('persons','aadhaar_last4'), ('persons','duplicate_key'),
    ('persons','aadhaar_locked_at'), ('persons','name_locked_at'),
    ('camps','id'), ('camps','name'), ('camps','is_active'), ('camps','venue'),
    ('camps','prescription_template'), ('camp_days','id'), ('camp_days','camp_id'),
    ('camp_days','day_date'), ('camp_days','seat_limit'), ('profiles','id'),
    ('profiles','role'), ('profiles','disabled_at'), ('profiles','team_lead_id'),
    ('sms_deliveries','id'), ('sms_deliveries','patient_id'), ('sms_deliveries','kind'),
    ('sms_deliveries','state'), ('sms_deliveries','claim_token'),
    ('sms_deliveries','phone_last4'), ('sms_deliveries','attempt_count'),
    ('sms_deliveries','dispatch_started_at'), ('sms_deliveries','updated_at'),
    ('public_rate_limit_buckets','scope'), ('public_rate_limit_buckets','key_hash'),
    ('public_rate_limit_buckets','window_started_at'),
    ('public_rate_limit_buckets','attempts'), ('public_rate_limit_buckets','expires_at'),
    ('prescription_transcriptions','id'), ('prescription_transcriptions','patient_id'),
    ('prescription_transcriptions','data'), ('prescription_transcriptions','paper_source'),
    ('prescription_transcriptions','created_by'), ('prescription_transcriptions','created_at'),
    ('prescription_transcriptions','updated_by'), ('prescription_transcriptions','updated_at'),
    ('prescription_transcriptions','locked_at'), ('prescription_transcriptions','archived_at'),
    ('prescription_corrections','id'), ('prescription_corrections','transcription_id'),
    ('prescription_corrections','reason'), ('prescription_corrections','correction_kind'),
    ('prescription_corrections','replacement_data'), ('prescription_corrections','created_by'),
    ('prescription_corrections','created_at'), ('fulfilment_items','id'),
    ('fulfilment_items','transcription_id'), ('fulfilment_items','kind'),
    ('fulfilment_items','outcome'), ('fulfilment_items','current_version'),
    ('fulfilment_items','resolved_by'), ('fulfilment_items','resolved_at'),
    ('fulfilment_items','unavailable_medicines'),
    ('fulfilment_events','id'), ('fulfilment_events','item_id'), ('fulfilment_events','event'),
    ('fulfilment_events','from_outcome'), ('fulfilment_events','to_outcome'),
    ('fulfilment_events','reason'), ('fulfilment_events','created_by'),
    ('fulfilment_events','created_at'), ('deferred_slips','id'), ('deferred_slips','item_id'),
    ('deferred_slips','reference'), ('deferred_slips','version'), ('deferred_slips','service'),
    ('deferred_slips','date_snapshot'), ('deferred_slips','venue_snapshot'),
    ('deferred_slips','issued_by'), ('deferred_slips','issued_at'), ('deferred_slips','status'),
    ('deferred_slips','replaced_by'), ('prescription_template_versions','id'),
    ('prescription_template_versions','camp_id'), ('prescription_template_versions','version'),
    ('prescription_template_versions','status'), ('prescription_template_versions','template'),
    ('prescription_template_versions','created_by'), ('prescription_template_versions','created_at'),
    ('prescription_template_versions','published_at'), ('sponsor_assets','id'),
    ('sponsor_assets','camp_id'), ('sponsor_assets','object_key'), ('sponsor_assets','mime_type'),
    ('sponsor_assets','byte_size'), ('sponsor_assets','created_by'), ('sponsor_assets','created_at'),
    ('sponsor_assets','state'), ('sponsor_assets','state_changed_at'),
    ('sponsor_assets','cleanup_attempts'), ('sponsor_assets','last_error_code'),
    ('aadhaar_extraction_events','id'), ('aadhaar_extraction_events','patient_id'),
    ('aadhaar_extraction_events','consent_at'), ('aadhaar_extraction_events','method'),
    ('aadhaar_extraction_events','trust_level'), ('aadhaar_extraction_events','outcome'),
    ('aadhaar_extraction_events','aadhaar_last4'), ('aadhaar_extraction_events','created_at')
  ) AS expected(table_name, column_name);

  SELECT jsonb_object_agg(expected.name, to_regprocedure(expected.signature) IS NOT NULL)
  INTO v_functions
  FROM (VALUES
    ('is_clinical_operator','public.is_clinical_operator()'),
    ('assert_valid_clinical_data','public.assert_valid_clinical_data(jsonb)'),
    ('clinical_lookup','public.clinical_lookup(uuid,integer)'),
    ('clinical_save_transcription','public.clinical_save_transcription(uuid,jsonb)'),
    ('clinical_add_correction','public.clinical_add_correction(uuid,jsonb,text)'),
    ('clinical_resolve_item','public.clinical_resolve_item(uuid,text,text,text[])'),
    ('clinical_followup_fulfil','public.clinical_followup_fulfil(uuid)'),
    ('clinical_followup_lookup','public.clinical_followup_lookup(uuid,integer)'),
    ('clinical_slip_by_id','public.clinical_slip_by_id(uuid)'),
    ('clinical_replace_slip','public.clinical_replace_slip(uuid,date,text,text)'),
    ('admin_prescription_template_editor','public.admin_prescription_template_editor(uuid)'),
    ('admin_save_prescription_template','public.admin_save_prescription_template(uuid,jsonb,boolean)'),
    ('admin_clinical_records','public.admin_clinical_records(uuid,boolean,integer,integer)'),
    ('admin_archive_transcription','public.admin_archive_transcription(uuid,boolean)'),
    ('admin_reverse_fulfilment','public.admin_reverse_fulfilment(uuid,text)'),
    ('published_prescription_template','public.published_prescription_template(uuid)'),
    ('audit_scanned_aadhaar_registration','public.audit_scanned_aadhaar_registration()'),
    ('latest_applied_migration','public.latest_applied_migration()'),
    ('readiness_catalog_probe','public.readiness_catalog_probe()'),
    ('patient_status_by_token','public.patient_status_by_token(text)'),
    ('upsert_camp_day','public.upsert_camp_day(uuid,date,integer,uuid)'),
    ('register_patient_idempotent','public.register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean,boolean,text,text,date,text)'),
    ('mark_patient_printed','public.mark_patient_printed(uuid,integer)'),
    ('lookup_patient_scan','public.lookup_patient_scan(uuid,integer)'),
    ('mark_seen','public.mark_seen(uuid,integer)'),
    ('undo_mark_seen','public.undo_mark_seen(uuid)'),
    ('lookup_patient_status_token','public.lookup_patient_status_token(integer,date)'),
    ('consume_public_rate_limit','public.consume_public_rate_limit(text,text[],integer,integer)'),
    ('active_registration_id','public.active_registration_id(uuid,integer)'),
    ('staff_person_kpis','public.staff_person_kpis(uuid,text,uuid,text)'),
    ('claim_sms_delivery','public.claim_sms_delivery(uuid,public.sms_delivery_kind,text,integer)'),
    ('mark_sms_dispatch_started','public.mark_sms_dispatch_started(uuid,uuid)'),
    ('complete_sms_delivery','public.complete_sms_delivery(uuid,uuid,text,text,text)'),
    ('patient_registration_notify_fields','public.patient_registration_notify_fields(uuid)'),
    ('camp_queue_counts','public.camp_queue_counts(uuid)'),
    ('search_desk_patients','public.search_desk_patients(uuid,text,integer)'),
    ('print_patient','public.print_patient(uuid)'),
    ('staff_registered_patients','public.staff_registered_patients(uuid,integer)'),
    ('begin_sponsor_asset_deletion','public.begin_sponsor_asset_deletion(uuid)'),
    ('finish_sponsor_asset_deletion','public.finish_sponsor_asset_deletion(uuid)'),
    ('admin_clinical_export','public.admin_clinical_export(uuid,text,boolean)')
  ) AS expected(name, signature);

  v_invariants := jsonb_build_object(
    'patients_camp_reg_no_unique', EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.patients'::regclass
        AND conname='patients_camp_reg_no_key' AND contype='u' AND convalidated
    ),
    'patients_person_camp_unique', EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.patients'::regclass
        AND conname='patients_person_camp_key' AND contype='u' AND convalidated
    ),
    'patients_person_id_not_null', EXISTS (
      SELECT 1 FROM pg_attribute WHERE attrelid='public.patients'::regclass
        AND attname='person_id' AND attnotnull AND NOT attisdropped
    ),
    'patients_provenance_current', EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.patients'::regclass
        AND conname='patients_provenance_check' AND convalidated
        AND pg_get_constraintdef(oid) LIKE '%self_declared%'
        AND pg_get_constraintdef(oid) LIKE '%card_scanned%'
        AND pg_get_constraintdef(oid) NOT LIKE '%ekyc_verified%'
    ),
    'retired_ekyc_storage_absent', NOT EXISTS (
      SELECT 1 FROM information_schema.columns WHERE table_schema='public'
        AND table_name='patients' AND column_name IN ('aadhaar_hash','aadhaar_verified_at','aadhaar_kyc_ref')
    ),
    'register_rpc_supported_signatures_only', (
      SELECT count(*)=1 AND bool_and(
        pg_get_function_arguments(p.oid) NOT ILIKE '%aadhaar_hash%'
        AND pg_get_function_arguments(p.oid) NOT ILIKE '%aadhaar_verified_at%'
        AND pg_get_function_arguments(p.oid) NOT ILIKE '%aadhaar_kyc_ref%'
      ) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='register_patient_idempotent'
    ) AND to_regprocedure('public.register_patient_v2(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean,text)') IS NULL,
    'patients_phone_provenance_current', EXISTS (
      SELECT 1 FROM information_schema.columns WHERE table_schema='public'
        AND table_name='patients' AND column_name='phone_provenance'
        AND is_nullable='NO' AND column_default LIKE '%self_declared%'
    ) AND EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.patients'::regclass
        AND conname='patients_phone_provenance_check' AND contype='c' AND convalidated
    ),
    'staff_kpi_single_contract', (
      SELECT count(*)=1 AND bool_and(p.oid=to_regprocedure('public.staff_person_kpis(uuid,text,uuid,text)'))
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='staff_person_kpis'
    ),
    'staff_leaderboard_absent', to_regprocedure('public.staff_leaderboard(uuid,uuid)') IS NULL,
    'migration_head_current', public.latest_applied_migration() = (
      SELECT max(version) FROM supabase_migrations.schema_migrations
    ),
    'profiles_team_lead_fk', EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.profiles'::regclass
        AND conname='profiles_team_lead_id_fkey' AND contype='f' AND convalidated
    ),
    'team_membership_guards', (
      SELECT count(*)=2 AND bool_and(tgenabled <> 'D') FROM pg_trigger
      WHERE tgrelid='public.profiles'::regclass AND NOT tgisinternal
        AND tgname IN ('validate_profile_team_membership','release_disabled_team_members')
    ),
    'prescription_records_absent', to_regclass('public.prescriptions') IS NULL
      AND to_regclass('public.treatment_orders') IS NULL
      AND to_regclass('public.prescription_amendments') IS NULL,
    'doctor_station_retired', to_regprocedure('public.assign_patient_doctor(uuid,integer,uuid)') IS NULL
      AND to_regprocedure('public.is_doctor()') IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.profiles WHERE role='doctor'::public.user_role AND disabled_at IS NULL),
    'mark_seen_contract', to_regprocedure('public.mark_seen(uuid,integer)') IS NOT NULL
      AND to_regprocedure('public.undo_mark_seen(uuid)') IS NOT NULL,
    'public_rate_limit_primary_key', EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.public_rate_limit_buckets'::regclass
        AND conname='public_rate_limit_buckets_pkey' AND contype='p' AND convalidated
    ),
    'transcription_patient_unique', EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.prescription_transcriptions'::regclass
        AND contype='u' AND pg_get_constraintdef(oid) LIKE '%(patient_id)%' AND convalidated
    ),
    'fulfilment_kind_unique', EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.fulfilment_items'::regclass
        AND contype='u' AND pg_get_constraintdef(oid) LIKE '%(transcription_id, kind)%' AND convalidated
    ),
    'deferred_one_active', to_regclass('public.deferred_slips_one_active') IS NOT NULL,
    'template_one_published', to_regclass('public.prescription_template_one_published') IS NOT NULL,
    'template_one_draft', to_regclass('public.prescription_template_one_draft') IS NOT NULL,
    'sponsor_object_key_unique', EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.sponsor_assets'::regclass
        AND contype='u' AND pg_get_constraintdef(oid) LIKE '%(object_key)%' AND convalidated
    ),
    'sponsor_state_check', EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.sponsor_assets'::regclass
        AND conname='sponsor_assets_state_check' AND convalidated
        AND pg_get_constraintdef(oid) LIKE '%pending%'
        AND pg_get_constraintdef(oid) LIKE '%ready%'
        AND pg_get_constraintdef(oid) LIKE '%deleting%'
    ),
    'aadhaar_event_patient_unique', EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.aadhaar_extraction_events'::regclass
        AND contype='u' AND pg_get_constraintdef(oid) LIKE '%(patient_id)%' AND convalidated
    ),
    'clinical_rls_enabled', (
      SELECT bool_and(relrowsecurity) FROM pg_class
      WHERE oid IN ('public.prescription_transcriptions'::regclass,
        'public.prescription_corrections'::regclass,'public.fulfilment_items'::regclass,
        'public.fulfilment_events'::regclass,'public.deferred_slips'::regclass,
        'public.prescription_template_versions'::regclass,'public.sponsor_assets'::regclass,
        'public.aadhaar_extraction_events'::regclass)
    ),
    'sponsor_bucket_private', EXISTS (
      SELECT 1 FROM storage.buckets WHERE id='prescription-sponsors' AND public=false
    ),
    'sponsor_bucket_restrictions', EXISTS (
      SELECT 1 FROM storage.buckets
      WHERE id='prescription-sponsors' AND file_size_limit=2097152
        AND cardinality(allowed_mime_types)=3
        AND allowed_mime_types @> ARRAY['image/png','image/jpeg','image/webp']::text[]
    )
  );

  v_grants := jsonb_build_object(
    'patients_status_token_authenticated_select', has_column_privilege('authenticated','public.patients','status_token','SELECT'),
    'patient_status_by_token_authenticated_execute', CASE WHEN to_regprocedure('public.patient_status_by_token(text)') IS NOT NULL THEN has_function_privilege('authenticated','public.patient_status_by_token(text)','EXECUTE') ELSE false END,
    'patient_status_by_token_anon_execute', CASE WHEN to_regprocedure('public.patient_status_by_token(text)') IS NOT NULL THEN has_function_privilege('anon','public.patient_status_by_token(text)','EXECUTE') ELSE false END,
    'patient_status_by_token_service_role_execute', CASE WHEN to_regprocedure('public.patient_status_by_token(text)') IS NOT NULL THEN has_function_privilege('service_role','public.patient_status_by_token(text)','EXECUTE') ELSE false END,
    'sms_deliveries_authenticated_select', has_table_privilege('authenticated','public.sms_deliveries','SELECT'),
    'claim_sms_delivery_service_role_execute', CASE WHEN to_regprocedure('public.claim_sms_delivery(uuid,public.sms_delivery_kind,text,integer)') IS NOT NULL THEN has_function_privilege('service_role','public.claim_sms_delivery(uuid,public.sms_delivery_kind,text,integer)','EXECUTE') ELSE false END,
    'complete_sms_delivery_service_role_execute', CASE WHEN to_regprocedure('public.complete_sms_delivery(uuid,uuid,text,text,text)') IS NOT NULL THEN has_function_privilege('service_role','public.complete_sms_delivery(uuid,uuid,text,text,text)','EXECUTE') ELSE false END,
    'upsert_camp_day_authenticated_execute', CASE WHEN to_regprocedure('public.upsert_camp_day(uuid,date,integer,uuid)') IS NOT NULL THEN has_function_privilege('authenticated','public.upsert_camp_day(uuid,date,integer,uuid)','EXECUTE') ELSE false END,
    'mark_patient_printed_authenticated_execute', CASE WHEN to_regprocedure('public.mark_patient_printed(uuid,integer)') IS NOT NULL THEN has_function_privilege('authenticated','public.mark_patient_printed(uuid,integer)','EXECUTE') ELSE false END,
    'lookup_patient_scan_authenticated_execute', CASE WHEN to_regprocedure('public.lookup_patient_scan(uuid,integer)') IS NOT NULL THEN has_function_privilege('authenticated','public.lookup_patient_scan(uuid,integer)','EXECUTE') ELSE false END,
    'search_desk_patients_authenticated_execute', CASE WHEN to_regprocedure('public.search_desk_patients(uuid,text,integer)') IS NOT NULL THEN has_function_privilege('authenticated','public.search_desk_patients(uuid,text,integer)','EXECUTE') ELSE false END,
    'search_desk_patients_anon_execute', CASE WHEN to_regprocedure('public.search_desk_patients(uuid,text,integer)') IS NOT NULL THEN has_function_privilege('anon','public.search_desk_patients(uuid,text,integer)','EXECUTE') ELSE false END,
    'mark_seen_authenticated_execute', CASE WHEN to_regprocedure('public.mark_seen(uuid,integer)') IS NOT NULL THEN has_function_privilege('authenticated','public.mark_seen(uuid,integer)','EXECUTE') ELSE false END,
    'mark_seen_anon_execute', CASE WHEN to_regprocedure('public.mark_seen(uuid,integer)') IS NOT NULL THEN has_function_privilege('anon','public.mark_seen(uuid,integer)','EXECUTE') ELSE false END,
    'undo_mark_seen_authenticated_execute', CASE WHEN to_regprocedure('public.undo_mark_seen(uuid)') IS NOT NULL THEN has_function_privilege('authenticated','public.undo_mark_seen(uuid)','EXECUTE') ELSE false END,
    'register_patient_idempotent_authenticated_execute', CASE WHEN to_regprocedure('public.register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean,boolean,text,text,date,text)') IS NOT NULL THEN has_function_privilege('authenticated','public.register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean,boolean,text,text,date,text)','EXECUTE') ELSE false END,
    'lookup_patient_status_token_anon_execute', CASE WHEN to_regprocedure('public.lookup_patient_status_token(integer,date)') IS NOT NULL THEN has_function_privilege('anon','public.lookup_patient_status_token(integer,date)','EXECUTE') ELSE false END,
    'lookup_patient_status_token_authenticated_execute', CASE WHEN to_regprocedure('public.lookup_patient_status_token(integer,date)') IS NOT NULL THEN has_function_privilege('authenticated','public.lookup_patient_status_token(integer,date)','EXECUTE') ELSE false END,
    'lookup_patient_status_token_service_role_execute', CASE WHEN to_regprocedure('public.lookup_patient_status_token(integer,date)') IS NOT NULL THEN has_function_privilege('service_role','public.lookup_patient_status_token(integer,date)','EXECUTE') ELSE false END,
    'consume_public_rate_limit_anon_execute', CASE WHEN to_regprocedure('public.consume_public_rate_limit(text,text[],integer,integer)') IS NOT NULL THEN has_function_privilege('anon','public.consume_public_rate_limit(text,text[],integer,integer)','EXECUTE') ELSE false END
  ) || jsonb_build_object(
    'consume_public_rate_limit_authenticated_execute', CASE WHEN to_regprocedure('public.consume_public_rate_limit(text,text[],integer,integer)') IS NOT NULL THEN has_function_privilege('authenticated','public.consume_public_rate_limit(text,text[],integer,integer)','EXECUTE') ELSE false END,
    'consume_public_rate_limit_service_role_execute', CASE WHEN to_regprocedure('public.consume_public_rate_limit(text,text[],integer,integer)') IS NOT NULL THEN has_function_privilege('service_role','public.consume_public_rate_limit(text,text[],integer,integer)','EXECUTE') ELSE false END,
    'staff_person_kpis_authenticated_execute', CASE WHEN to_regprocedure('public.staff_person_kpis(uuid,text,uuid,text)') IS NOT NULL THEN has_function_privilege('authenticated','public.staff_person_kpis(uuid,text,uuid,text)','EXECUTE') ELSE false END,
    'staff_person_kpis_anon_execute', CASE WHEN to_regprocedure('public.staff_person_kpis(uuid,text,uuid,text)') IS NOT NULL THEN has_function_privilege('anon','public.staff_person_kpis(uuid,text,uuid,text)','EXECUTE') ELSE false END,
    'staff_person_kpis_service_role_execute', CASE WHEN to_regprocedure('public.staff_person_kpis(uuid,text,uuid,text)') IS NOT NULL THEN has_function_privilege('service_role','public.staff_person_kpis(uuid,text,uuid,text)','EXECUTE') ELSE false END,
    'staff_leaderboard_authenticated_execute', to_regprocedure('public.staff_leaderboard(uuid,uuid)') IS NOT NULL,
    'mark_sms_dispatch_started_authenticated_execute', CASE WHEN to_regprocedure('public.mark_sms_dispatch_started(uuid,uuid)') IS NOT NULL THEN has_function_privilege('authenticated','public.mark_sms_dispatch_started(uuid,uuid)','EXECUTE') ELSE false END,
    'mark_sms_dispatch_started_service_role_execute', CASE WHEN to_regprocedure('public.mark_sms_dispatch_started(uuid,uuid)') IS NOT NULL THEN has_function_privilege('service_role','public.mark_sms_dispatch_started(uuid,uuid)','EXECUTE') ELSE false END,
    'patient_registration_notify_fields_authenticated_execute', CASE WHEN to_regprocedure('public.patient_registration_notify_fields(uuid)') IS NOT NULL THEN has_function_privilege('authenticated','public.patient_registration_notify_fields(uuid)','EXECUTE') ELSE false END,
    'camp_queue_counts_authenticated_execute', CASE WHEN to_regprocedure('public.camp_queue_counts(uuid)') IS NOT NULL THEN has_function_privilege('authenticated','public.camp_queue_counts(uuid)','EXECUTE') ELSE false END,
    'camp_queue_counts_anon_execute', CASE WHEN to_regprocedure('public.camp_queue_counts(uuid)') IS NOT NULL THEN has_function_privilege('anon','public.camp_queue_counts(uuid)','EXECUTE') ELSE false END,
    'camp_queue_counts_service_role_execute', CASE WHEN to_regprocedure('public.camp_queue_counts(uuid)') IS NOT NULL THEN has_function_privilege('service_role','public.camp_queue_counts(uuid)','EXECUTE') ELSE false END,
    'latest_applied_migration_service_role_execute', CASE WHEN to_regprocedure('public.latest_applied_migration()') IS NOT NULL THEN has_function_privilege('service_role','public.latest_applied_migration()','EXECUTE') ELSE false END,
    'persons_authenticated_select', has_table_privilege('authenticated','public.persons','SELECT'),
    'persons_authenticated_write', has_table_privilege('authenticated','public.persons','INSERT') OR has_table_privilege('authenticated','public.persons','UPDATE'),
    'patients_authenticated_select', has_table_privilege('authenticated','public.patients','SELECT'),
    'prescription_transcriptions_authenticated_write', has_table_privilege('authenticated','public.prescription_transcriptions','INSERT') OR has_table_privilege('authenticated','public.prescription_transcriptions','UPDATE') OR has_table_privilege('authenticated','public.prescription_transcriptions','DELETE'),
    'prescription_corrections_authenticated_write', has_table_privilege('authenticated','public.prescription_corrections','INSERT') OR has_table_privilege('authenticated','public.prescription_corrections','UPDATE') OR has_table_privilege('authenticated','public.prescription_corrections','DELETE'),
    'fulfilment_items_authenticated_write', has_table_privilege('authenticated','public.fulfilment_items','INSERT') OR has_table_privilege('authenticated','public.fulfilment_items','UPDATE') OR has_table_privilege('authenticated','public.fulfilment_items','DELETE'),
    'fulfilment_events_authenticated_write', has_table_privilege('authenticated','public.fulfilment_events','INSERT') OR has_table_privilege('authenticated','public.fulfilment_events','UPDATE') OR has_table_privilege('authenticated','public.fulfilment_events','DELETE')
  ) || jsonb_build_object(
    'deferred_slips_authenticated_write', has_table_privilege('authenticated','public.deferred_slips','INSERT') OR has_table_privilege('authenticated','public.deferred_slips','UPDATE') OR has_table_privilege('authenticated','public.deferred_slips','DELETE'),
    'prescription_template_versions_authenticated_write', has_table_privilege('authenticated','public.prescription_template_versions','INSERT') OR has_table_privilege('authenticated','public.prescription_template_versions','UPDATE') OR has_table_privilege('authenticated','public.prescription_template_versions','DELETE'),
    'sponsor_assets_authenticated_write', has_table_privilege('authenticated','public.sponsor_assets','INSERT') OR has_table_privilege('authenticated','public.sponsor_assets','UPDATE') OR has_table_privilege('authenticated','public.sponsor_assets','DELETE'),
    'aadhaar_extraction_events_authenticated_write', has_table_privilege('authenticated','public.aadhaar_extraction_events','INSERT') OR has_table_privilege('authenticated','public.aadhaar_extraction_events','UPDATE') OR has_table_privilege('authenticated','public.aadhaar_extraction_events','DELETE'),
    'aadhaar_extraction_events_authenticated_access', has_table_privilege('authenticated','public.aadhaar_extraction_events','SELECT') OR has_table_privilege('authenticated','public.aadhaar_extraction_events','INSERT') OR has_table_privilege('authenticated','public.aadhaar_extraction_events','UPDATE') OR has_table_privilege('authenticated','public.aadhaar_extraction_events','DELETE'),
    'prescription_transcriptions_anon_access', has_table_privilege('anon','public.prescription_transcriptions','SELECT') OR has_table_privilege('anon','public.prescription_transcriptions','INSERT') OR has_table_privilege('anon','public.prescription_transcriptions','UPDATE') OR has_table_privilege('anon','public.prescription_transcriptions','DELETE'),
    'prescription_corrections_anon_access', has_table_privilege('anon','public.prescription_corrections','SELECT') OR has_table_privilege('anon','public.prescription_corrections','INSERT') OR has_table_privilege('anon','public.prescription_corrections','UPDATE') OR has_table_privilege('anon','public.prescription_corrections','DELETE'),
    'fulfilment_items_anon_access', has_table_privilege('anon','public.fulfilment_items','SELECT') OR has_table_privilege('anon','public.fulfilment_items','INSERT') OR has_table_privilege('anon','public.fulfilment_items','UPDATE') OR has_table_privilege('anon','public.fulfilment_items','DELETE'),
    'fulfilment_events_anon_access', has_table_privilege('anon','public.fulfilment_events','SELECT') OR has_table_privilege('anon','public.fulfilment_events','INSERT') OR has_table_privilege('anon','public.fulfilment_events','UPDATE') OR has_table_privilege('anon','public.fulfilment_events','DELETE'),
    'deferred_slips_anon_access', has_table_privilege('anon','public.deferred_slips','SELECT') OR has_table_privilege('anon','public.deferred_slips','INSERT') OR has_table_privilege('anon','public.deferred_slips','UPDATE') OR has_table_privilege('anon','public.deferred_slips','DELETE'),
    'prescription_template_versions_anon_access', has_table_privilege('anon','public.prescription_template_versions','SELECT') OR has_table_privilege('anon','public.prescription_template_versions','INSERT') OR has_table_privilege('anon','public.prescription_template_versions','UPDATE') OR has_table_privilege('anon','public.prescription_template_versions','DELETE'),
    'sponsor_assets_anon_access', has_table_privilege('anon','public.sponsor_assets','SELECT') OR has_table_privilege('anon','public.sponsor_assets','INSERT') OR has_table_privilege('anon','public.sponsor_assets','UPDATE') OR has_table_privilege('anon','public.sponsor_assets','DELETE'),
    'aadhaar_extraction_events_anon_access', has_table_privilege('anon','public.aadhaar_extraction_events','SELECT') OR has_table_privilege('anon','public.aadhaar_extraction_events','INSERT') OR has_table_privilege('anon','public.aadhaar_extraction_events','UPDATE') OR has_table_privilege('anon','public.aadhaar_extraction_events','DELETE'),
    'clinical_callable_authenticated_execute', (SELECT coalesce(bool_and(has_function_privilege('authenticated', sig, 'EXECUTE')), true) FROM unnest(v_clinical_signatures) sig),
    'clinical_callable_service_role_execute', (SELECT coalesce(bool_and(has_function_privilege('service_role', sig, 'EXECUTE')), true) FROM unnest(v_clinical_signatures) sig),
    'clinical_internal_anon_execute', (SELECT coalesce(bool_or(has_function_privilege('anon', sig, 'EXECUTE')), false) FROM unnest(v_clinical_signatures) sig),
    'clinical_callable_public_execute', (SELECT coalesce(bool_or(has_function_privilege('anon', sig, 'EXECUTE')), false) FROM unnest(v_clinical_signatures) sig),
    'assert_valid_clinical_data_authenticated_execute', has_function_privilege('authenticated','public.assert_valid_clinical_data(jsonb)','EXECUTE'),
    'assert_valid_clinical_data_anon_execute', has_function_privilege('anon','public.assert_valid_clinical_data(jsonb)','EXECUTE'),
    'assert_valid_clinical_data_service_role_execute', has_function_privilege('service_role','public.assert_valid_clinical_data(jsonb)','EXECUTE'),
    'audit_scanned_aadhaar_authenticated_execute', CASE WHEN to_regprocedure('public.audit_scanned_aadhaar_registration()') IS NOT NULL THEN has_function_privilege('authenticated','public.audit_scanned_aadhaar_registration()','EXECUTE') ELSE false END,
    'audit_scanned_aadhaar_anon_execute', CASE WHEN to_regprocedure('public.audit_scanned_aadhaar_registration()') IS NOT NULL THEN has_function_privilege('anon','public.audit_scanned_aadhaar_registration()','EXECUTE') ELSE false END,
    'audit_scanned_aadhaar_service_role_execute', CASE WHEN to_regprocedure('public.audit_scanned_aadhaar_registration()') IS NOT NULL THEN has_function_privilege('service_role','public.audit_scanned_aadhaar_registration()','EXECUTE') ELSE false END,
    'print_patient_authenticated_execute', CASE WHEN to_regprocedure('public.print_patient(uuid)') IS NOT NULL THEN has_function_privilege('authenticated','public.print_patient(uuid)','EXECUTE') ELSE false END,
    'staff_registered_patients_authenticated_execute', CASE WHEN to_regprocedure('public.staff_registered_patients(uuid,integer)') IS NOT NULL THEN has_function_privilege('authenticated','public.staff_registered_patients(uuid,integer)','EXECUTE') ELSE false END,
    'begin_sponsor_asset_deletion_authenticated_execute', CASE WHEN to_regprocedure('public.begin_sponsor_asset_deletion(uuid)') IS NOT NULL THEN has_function_privilege('authenticated','public.begin_sponsor_asset_deletion(uuid)','EXECUTE') ELSE false END,
    'finish_sponsor_asset_deletion_authenticated_execute', CASE WHEN to_regprocedure('public.finish_sponsor_asset_deletion(uuid)') IS NOT NULL THEN has_function_privilege('authenticated','public.finish_sponsor_asset_deletion(uuid)','EXECUTE') ELSE false END
  );

  SELECT jsonb_object_agg(expected.name, EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
    JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' AND t.typname='sms_delivery_state' AND e.enumlabel=expected.name
  )) INTO v_states
  FROM (VALUES ('pending'),('sending'),('sent'),('failed'),('ambiguous')) expected(name);

  SELECT jsonb_object_agg(expected.name, EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
    JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' AND t.typname='sms_delivery_kind' AND e.enumlabel=expected.name
  )) INTO v_kinds
  FROM (VALUES ('registration'),('reminder')) expected(name);

  RETURN jsonb_build_object(
    'tables', v_tables,
    'columns', v_columns,
    'functions', v_functions,
    'invariants', v_invariants,
    'grants', v_grants,
    'publication', jsonb_build_object('patients_in_supabase_realtime', EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='patients'
    )),
    'sms', jsonb_build_object(
      'table', to_regclass('public.sms_deliveries') IS NOT NULL,
      'states', v_states,
      'kinds', v_kinds,
      'claim_fn', to_regprocedure('public.claim_sms_delivery(uuid,public.sms_delivery_kind,text,integer)') IS NOT NULL,
      'dispatch_fn', to_regprocedure('public.mark_sms_dispatch_started(uuid,uuid)') IS NOT NULL,
      'complete_fn', to_regprocedure('public.complete_sms_delivery(uuid,uuid,text,text,text)') IS NOT NULL
    )
  );
END;
$function$;

ALTER FUNCTION public.readiness_catalog_probe() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.readiness_catalog_probe() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_catalog_probe()
  TO service_role, postgres;
