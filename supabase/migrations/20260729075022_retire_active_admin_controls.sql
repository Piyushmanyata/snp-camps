-- #123: retire misleading admin controls, harden queue/SMS lifecycle, and add
-- aggregate-only active-camp analytics. Historical columns remain intact when
-- dropping them would create production-data risk; active contracts no longer
-- read or write them.

-- ---------------------------------------------------------------------------
-- Admin analytics: one bounded aggregate RPC, callable only by an active admin.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.camp_queue_counts(uuid);

CREATE FUNCTION public.camp_queue_counts(p_camp_id uuid)
RETURNS TABLE(
  registered_count bigint,
  waiting_count bigint,
  seen_count bigint,
  total_count bigint,
  current_longest_wait_minutes numeric,
  completed_wait_median_minutes numeric,
  completed_wait_p90_minutes numeric,
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
    SELECT
      p.queue_status,
      p.queued_at,
      p.seen_at,
      p.created_by,
      p.provenance
    FROM public.patients AS p
    JOIN public.camps AS c
      ON c.id = p.camp_id
     AND c.is_active = true
    WHERE p.camp_id = p_camp_id
  ),
  valid_completed AS (
    SELECT
      extract(epoch FROM (s.seen_at - s.queued_at)) / 60.0 AS wait_minutes
    FROM scoped AS s
    WHERE s.queue_status = 'seen'::public.queue_status
      AND s.queued_at IS NOT NULL
      AND s.seen_at IS NOT NULL
      AND s.seen_at >= s.queued_at
  )
  SELECT
    count(*) FILTER (
      WHERE s.queue_status = 'registered'::public.queue_status
    )::bigint,
    count(*) FILTER (
      WHERE s.queue_status = 'waiting'::public.queue_status
    )::bigint,
    count(*) FILTER (
      WHERE s.queue_status = 'seen'::public.queue_status
    )::bigint,
    count(*)::bigint,
    round(
      max(
        extract(epoch FROM (now() - s.queued_at)) / 60.0
      ) FILTER (
        WHERE s.queue_status = 'waiting'::public.queue_status
          AND s.queued_at IS NOT NULL
          AND now() >= s.queued_at
      )::numeric,
      1
    ),
    (
      SELECT round(
        percentile_cont(0.5) WITHIN GROUP (ORDER BY v.wait_minutes)::numeric,
        1
      )
      FROM valid_completed AS v
    ),
    (
      SELECT round(
        percentile_cont(0.9) WITHIN GROUP (ORDER BY v.wait_minutes)::numeric,
        1
      )
      FROM valid_completed AS v
    ),
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
  'Admin-only aggregate queue, wait, throughput, and authoritative registration-source metrics for one camp.';

-- ---------------------------------------------------------------------------
-- Retire the print-mode setting from the active write contract. The historical
-- paper_fallback_mode column remains inert to avoid destructive cleanup.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.update_camp_settings(
  uuid, date, text, date, text, boolean
);

CREATE FUNCTION public.update_camp_settings(
  p_camp_id uuid,
  p_spectacles_collection_date date DEFAULT NULL,
  p_spectacles_collection_venue text DEFAULT NULL,
  p_post_camp_surgery_date date DEFAULT NULL,
  p_post_camp_surgery_venue text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_updated_count integer;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin role required to update camp settings'
      USING ERRCODE = '42501';
  END IF;

  IF p_spectacles_collection_venue IS NOT NULL
     AND char_length(p_spectacles_collection_venue) > 35 THEN
    RAISE EXCEPTION
      'Spectacles collection venue exceeds maximum length of 35 characters'
      USING ERRCODE = '22001';
  END IF;

  IF p_post_camp_surgery_venue IS NOT NULL
     AND char_length(p_post_camp_surgery_venue) > 35 THEN
    RAISE EXCEPTION
      'Post-camp surgery venue exceeds maximum length of 35 characters'
      USING ERRCODE = '22001';
  END IF;

  UPDATE public.camps
  SET
    spectacles_collection_date = p_spectacles_collection_date,
    spectacles_collection_venue = p_spectacles_collection_venue,
    post_camp_surgery_date = p_post_camp_surgery_date,
    post_camp_surgery_venue = p_post_camp_surgery_venue
  WHERE id = p_camp_id;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count = 0 THEN
    RAISE EXCEPTION 'Camp not found' USING ERRCODE = 'P0002';
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$function$;

ALTER FUNCTION public.update_camp_settings(uuid, date, text, date, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.update_camp_settings(uuid, date, text, date, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_camp_settings(
  uuid, date, text, date, text
) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Registration SMS: self-registration and same-day registrations must never
-- create a live delivery. A trigger protects every ledger insertion path,
-- including future callers, while the notify projection enforces the same rule.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_registration_sms_eligibility()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_created_by uuid;
  v_day_date date;
BEGIN
  IF NEW.kind IS DISTINCT FROM 'registration'::public.sms_delivery_kind THEN
    RETURN NEW;
  END IF;

  SELECT p.created_by, d.day_date
  INTO v_created_by, v_day_date
  FROM public.patients AS p
  LEFT JOIN public.camp_days AS d ON d.id = p.camp_day_id
  WHERE p.id = NEW.patient_id;

  IF v_day_date IS NOT NULL
     AND (
       v_created_by IS NULL
       OR v_day_date <= (timezone('Asia/Kolkata', now()))::date
     ) THEN
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.enforce_registration_sms_eligibility() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_registration_sms_eligibility()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS enforce_registration_sms_eligibility
  ON public.sms_deliveries;
CREATE TRIGGER enforce_registration_sms_eligibility
BEFORE INSERT ON public.sms_deliveries
FOR EACH ROW EXECUTE FUNCTION public.enforce_registration_sms_eligibility();

CREATE OR REPLACE FUNCTION public.claim_sms_delivery(
  p_patient_id uuid,
  p_kind public.sms_delivery_kind,
  p_phone_last4 text DEFAULT NULL,
  p_lease_seconds integer DEFAULT 120
) RETURNS TABLE(delivery_id uuid, claim_token uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF p_kind = 'registration'
     AND EXISTS (
       SELECT 1
       FROM public.patients AS p
       LEFT JOIN public.camp_days AS d ON d.id = p.camp_day_id
       WHERE p.id = p_patient_id
         AND (
           (
             p.created_by IS NULL
             AND p.provenance = 'card_verified'
           )
           OR (
             d.day_date IS NOT NULL
             AND (
               p.created_by IS NULL
               OR d.day_date <= (timezone('Asia/Kolkata', now()))::date
             )
           )
         )
     )
  THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT *
  FROM public.claim_sms_delivery_impl(
    p_patient_id,
    p_kind,
    p_phone_last4,
    p_lease_seconds
  );
END;
$function$;

ALTER FUNCTION public.claim_sms_delivery(
  uuid, public.sms_delivery_kind, text, integer
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_sms_delivery(
  uuid, public.sms_delivery_kind, text, integer
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_sms_delivery(
  uuid, public.sms_delivery_kind, text, integer
) TO authenticated, service_role, postgres;

CREATE OR REPLACE FUNCTION public.patient_registration_notify_fields(
  p_patient_id uuid
) RETURNS TABLE(
  id uuid,
  reg_no integer,
  phone text,
  status_token text,
  venue text,
  day_date date
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF NOT public.is_staff() THEN
    RAISE EXCEPTION 'staff only';
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    p.reg_no,
    p.phone,
    p.status_token,
    c.venue,
    d.day_date
  FROM public.patients AS p
  JOIN public.camps AS c ON c.id = p.camp_id
  JOIN public.camp_days AS d ON d.id = p.camp_day_id
  WHERE p.id = p_patient_id
    AND p.created_by IS NOT NULL
    AND d.day_date > (timezone('Asia/Kolkata', now()))::date;
END;
$function$;

ALTER FUNCTION public.patient_registration_notify_fields(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.patient_registration_notify_fields(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.patient_registration_notify_fields(uuid)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Undo may repair a recent mis-scan only while the patient's camp is active.
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
  v_camp_active boolean;
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

  SELECT c.is_active INTO v_camp_active
  FROM public.camps AS c
  WHERE c.id = r.camp_id
  FOR UPDATE;

  IF v_camp_active IS DISTINCT FROM true THEN
    RETURN QUERY
    SELECT r.id, r.reg_no, r.full_name, r.queue_status, 'inactive_camp'::text;
    RETURN;
  END IF;

  IF r.queue_status IS DISTINCT FROM 'seen' THEN
    RETURN QUERY
    SELECT r.id, r.reg_no, r.full_name, r.queue_status, 'not_seen'::text;
    RETURN;
  END IF;

  IF r.seen_at IS NULL OR r.seen_at < now() - interval '10 minutes' THEN
    RETURN QUERY
    SELECT r.id, r.reg_no, r.full_name, r.queue_status,
      'undo_window_expired'::text;
    RETURN;
  END IF;

  UPDATE public.patients AS p
  SET queue_status = 'waiting',
      seen_at = NULL,
      seen_by = NULL
  WHERE p.id = r.id
  RETURNING p.* INTO r;

  RETURN QUERY
  SELECT r.id, r.reg_no, r.full_name, r.queue_status, NULL::text;
END;
$function$;

ALTER FUNCTION public.undo_mark_seen(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.undo_mark_seen(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.undo_mark_seen(uuid)
  TO authenticated, service_role;

-- The unified KPI function predates role retirement. Remove its residual
-- caller, target, label, and query branches while preserving the established
-- team/volunteer aggregation contract.
DO $migration$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(
    'public.staff_person_kpis(uuid,text,uuid,timestamptz,text)'::regprocedure
  ) INTO v_definition;

  v_old := $old$profile.role IN ('admin', 'team_lead', 'volunteer', 'doctor')$old$;
  v_new := $new$profile.role IN ('admin', 'team_lead', 'volunteer')$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'staff KPI caller-role anchor not found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $old$profile.role IN ('team_lead', 'volunteer', 'doctor')$old$;
  v_new := $new$profile.role IN ('team_lead', 'volunteer')$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'staff KPI target-role anchor not found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $old$  IF v_target_role = 'doctor' THEN
    v_label := 'Patients seen';
  ELSE
    v_label := 'Patients handled';
  END IF;$old$;
  v_new := $new$  v_label := 'Patients handled';$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'staff KPI label anchor not found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $old$  IF v_target_role = 'doctor' THEN
    RETURN QUERY
    SELECT
      count(*)::bigint,
      count(*) FILTER (WHERE patient.seen_at >= v_since)::bigint,
      0::bigint,
      count(*)::bigint,
      v_label,
      NULL::uuid,
      NULL::text,
      NULL::public.user_role,
      NULL::integer,
      NULL::uuid,
      NULL::integer
    FROM public.patients AS patient
    WHERE patient.seen_by = p_user_id
      AND patient.queue_status = 'seen'
      AND patient.camp_id = v_active_camp_id;
  ELSIF v_target_role = 'team_lead' THEN$old$;
  v_new := $new$  IF v_target_role = 'team_lead' THEN$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'staff KPI retired branch anchor not found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  EXECUTE v_definition;
END
$migration$;

-- ---------------------------------------------------------------------------
-- Extend and advance the runtime readiness probe without duplicating its large
-- catalog inventory.
-- ---------------------------------------------------------------------------

DO $migration$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(
    'public.readiness_catalog_probe()'::regprocedure
  ) INTO v_definition;

  v_old := $old$('patient_registration_notify_fields')$old$;
  v_new := $new$('patient_registration_notify_fields'),
      ('camp_queue_counts')$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'readiness function inventory anchor not found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $old$'latest_applied_migration_service_role_execute',$old$;
  v_new := $new$'camp_queue_counts_authenticated_execute',
      has_function_privilege('authenticated', 'public.camp_queue_counts(uuid)', 'EXECUTE'),
    'camp_queue_counts_anon_execute',
      has_function_privilege('anon', 'public.camp_queue_counts(uuid)', 'EXECUTE'),
    'camp_queue_counts_service_role_execute',
      has_function_privilege('service_role', 'public.camp_queue_counts(uuid)', 'EXECUTE'),
    'latest_applied_migration_service_role_execute',$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'readiness grant inventory anchor not found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $old$public.latest_applied_migration() = '20260728119000'$old$;
  v_new := $new$public.latest_applied_migration() = '20260729075022'$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'readiness migration head anchor not found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  EXECUTE v_definition;
END
$migration$;
