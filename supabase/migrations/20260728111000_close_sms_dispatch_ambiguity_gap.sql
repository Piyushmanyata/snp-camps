-- Distinguish a reclaimable crash before provider dispatch from an unknown
-- outcome after dispatch began. This closes the accepted-send / failed-ledger
-- completion gap without sacrificing stale pre-dispatch recovery (#65).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.sms_deliveries WHERE state = 'sending'
  ) THEN
    RAISE EXCEPTION
      'Cannot add dispatch boundary while SMS deliveries are sending';
  END IF;
END
$$;

ALTER TABLE public.sms_deliveries
  ADD COLUMN dispatch_started_at timestamptz;

CREATE OR REPLACE FUNCTION public.mark_sms_dispatch_started(
  p_delivery_id uuid,
  p_claim_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_role text;
  v_updated integer;
BEGIN
  v_role := coalesce(
    nullif(auth.role(), ''),
    nullif(current_setting('request.jwt.claim.role', true), '')
  );
  IF v_role IS DISTINCT FROM 'service_role' AND NOT public.is_staff() THEN
    RAISE EXCEPTION 'staff or service role required';
  END IF;

  UPDATE public.sms_deliveries AS delivery
  SET dispatch_started_at = coalesce(delivery.dispatch_started_at, now()),
      updated_at = now()
  WHERE delivery.id = p_delivery_id
    AND delivery.claim_token IS NOT DISTINCT FROM p_claim_token
    AND delivery.state = 'sending'
    AND delivery.claim_expires_at >= now();
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

ALTER FUNCTION public.mark_sms_dispatch_started(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mark_sms_dispatch_started(uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_sms_dispatch_started(uuid, uuid)
  TO authenticated, service_role, postgres;

CREATE OR REPLACE FUNCTION public.claim_sms_delivery_impl(
  p_patient_id uuid,
  p_kind public.sms_delivery_kind,
  p_phone_last4 text DEFAULT NULL,
  p_lease_seconds integer DEFAULT 120
)
RETURNS TABLE (
  delivery_id uuid,
  claim_token uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_role text;
  v_last4 char(4);
  v_lease integer := greatest(coalesce(p_lease_seconds, 120), 30);
BEGIN
  v_role := coalesce(
    nullif(auth.role(), ''),
    nullif(current_setting('request.jwt.claim.role', true), '')
  );
  IF v_role IS DISTINCT FROM 'service_role' AND NOT public.is_staff() THEN
    RAISE EXCEPTION 'staff or service role required';
  END IF;

  IF p_patient_id IS NULL OR p_kind IS NULL THEN
    RAISE EXCEPTION 'patient and kind required';
  END IF;

  v_last4 := NULL;
  IF p_phone_last4 IS NOT NULL AND length(trim(p_phone_last4)) > 0 THEN
    v_last4 := right(regexp_replace(p_phone_last4, '\D', '', 'g'), 4);
    IF v_last4 !~ '^[0-9]{4}$' THEN
      v_last4 := NULL;
    END IF;
  END IF;

  INSERT INTO public.sms_deliveries (patient_id, kind, state, phone_last4)
  VALUES (p_patient_id, p_kind, 'pending', v_last4)
  ON CONFLICT (patient_id, kind) DO NOTHING;

  IF v_last4 IS NOT NULL THEN
    UPDATE public.sms_deliveries AS delivery
    SET phone_last4 = v_last4
    WHERE delivery.patient_id = p_patient_id
      AND delivery.kind = p_kind
      AND delivery.phone_last4 IS NULL;
  END IF;

  -- Once dispatch began, an expired process lease has an unknown provider
  -- outcome. Make that uncertainty terminal before considering a new claim.
  UPDATE public.sms_deliveries AS delivery
  SET state = 'ambiguous',
      claim_expires_at = NULL,
      last_error = coalesce(
        delivery.last_error,
        'dispatch outcome unknown after worker lease expired'
      ),
      updated_at = now()
  WHERE delivery.patient_id = p_patient_id
    AND delivery.kind = p_kind
    AND delivery.state = 'sending'
    AND delivery.claim_expires_at IS NOT NULL
    AND delivery.claim_expires_at < now()
    AND delivery.dispatch_started_at IS NOT NULL;

  RETURN QUERY
  WITH claimed AS (
    UPDATE public.sms_deliveries AS delivery
    SET state = 'sending',
        claim_token = gen_random_uuid(),
        claim_expires_at = now() + make_interval(secs => v_lease),
        dispatch_started_at = NULL,
        attempt_count = delivery.attempt_count + 1,
        last_error = NULL,
        updated_at = now()
    WHERE delivery.patient_id = p_patient_id
      AND delivery.kind = p_kind
      AND (
        delivery.state IN ('pending', 'failed')
        OR (
          delivery.state = 'sending'
          AND delivery.claim_expires_at IS NOT NULL
          AND delivery.claim_expires_at < now()
          AND delivery.dispatch_started_at IS NULL
        )
      )
    RETURNING delivery.id, delivery.claim_token
  ),
  legacy AS (
    UPDATE public.patients AS patient
    SET reminder_sms_sent_at = coalesce(patient.reminder_sms_sent_at, now())
    WHERE p_kind = 'reminder'
      AND EXISTS (SELECT 1 FROM claimed)
      AND patient.id = p_patient_id
    RETURNING patient.id
  )
  SELECT claimed.id, claimed.claim_token FROM claimed;
END;
$$;

ALTER FUNCTION public.claim_sms_delivery_impl(
  uuid, public.sms_delivery_kind, text, integer
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_sms_delivery_impl(
  uuid, public.sms_delivery_kind, text, integer
) FROM PUBLIC, anon, authenticated, service_role;
