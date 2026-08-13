-- Batch 1: registration/printing separation, status privacy, and exact public
-- status projection. Historical migrations remain append-only.

-- Keep the accepted registration implementation as a private compatibility
-- helper, then expose the same public signature with the print-only queue
-- transition contract.
ALTER FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, boolean, text, text, date, text
) RENAME TO register_patient_idempotent_preprint_queue;

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
  p_display_name text DEFAULT NULL
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
DECLARE
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

      -- The legacy implementation enforces capacity for every registration.
      -- Temporarily reserve one registration slot only inside this transaction
      -- for a same-day desk walk-in; the row lock prevents concurrent overbook.
      IF v_is_walkin AND v_taken >= v_day.seat_limit THEN
        v_original_limit := v_day.seat_limit;
        UPDATE public.camp_days
        SET seat_limit = v_taken + 1
        WHERE id = p_camp_day_id;
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
      p_provenance,
      p_duplicate_key,
      p_date_of_birth,
      p_display_name
    ) AS r;
  EXCEPTION WHEN OTHERS THEN
    IF v_original_limit IS NOT NULL THEN
      UPDATE public.camp_days
      SET seat_limit = v_original_limit
      WHERE id = p_camp_day_id;
    END IF;
    RAISE;
  END;

  IF v_original_limit IS NOT NULL THEN
    UPDATE public.camp_days
    SET seat_limit = v_original_limit
    WHERE id = p_camp_day_id;
  END IF;

  IF v_result.id IS NULL THEN
    RAISE EXCEPTION 'Registration did not return a patient';
  END IF;

  -- Only a row created by this request is changed. Retries and Person-level
  -- duplicate returns preserve an already-established waiting/seen state.
  IF NOT v_existing_request THEN
    UPDATE public.patients AS p
    SET queue_status = 'registered',
        queued_at = NULL,
        checked_in_by = NULL
    WHERE p.registration_request_id = p_request_id
      AND p.id = v_result.id;
  END IF;

  SELECT p.*
  INTO v_patient
  FROM public.patients AS p
  WHERE p.id = v_result.id;

  id := v_patient.id;
  reg_no := v_patient.reg_no;
  full_name := coalesce(v_patient.display_name, v_patient.full_name);
  camp_day_id := v_patient.camp_day_id;
  SELECT d.day_date INTO day_date
  FROM public.camp_days AS d
  WHERE d.id = v_patient.camp_day_id;
  queue_status := v_patient.queue_status;
  RETURN NEXT;
END;
$function$;

ALTER FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, boolean, text, text, date, text
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, boolean, text, text, date, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, boolean, text, text, date, text
) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.register_patient_idempotent_preprint_queue(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, boolean, text, text, date, text
) FROM PUBLIC, anon, authenticated, service_role;

-- The status bearer is intentionally PII-free. Keep only the registration,
-- queue, venue/day, and staff-scan identifier needed by the patient workflow.
DROP FUNCTION IF EXISTS public.patient_status_by_token(text);

CREATE FUNCTION public.patient_status_by_token(p_token text)
RETURNS TABLE(
  reg_no integer,
  queue_status public.queue_status,
  queue_position integer,
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
  v_position integer;
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

  IF v_status = 'waiting'::public.queue_status THEN
    SELECT ranked.pos::integer
    INTO v_position
    FROM (
      SELECT peer.id,
             row_number() OVER (
               ORDER BY peer.queued_at ASC NULLS LAST, peer.reg_no ASC, peer.id ASC
             ) AS pos
      FROM public.patients AS peer
      WHERE peer.camp_id = v_camp_id
        AND peer.queue_status = 'waiting'::public.queue_status
    ) AS ranked
    WHERE ranked.id = v_id;
    queue_position := v_position;
  ELSE
    queue_position := NULL;
  END IF;

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
  'PII-free bearer status projection: registration, queue, camp/day, venue, and staff-scan patient id only.';
