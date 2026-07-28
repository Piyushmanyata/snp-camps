-- #35: a self-declared phone from public self-registration must never receive
-- the live status-link SMS. Enforce this at every database entry point.

CREATE OR REPLACE FUNCTION public.reject_self_registration_delivery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
  IF NEW.kind = 'registration'
     AND EXISTS (
       SELECT 1
       FROM public.patients AS p
       WHERE p.id = NEW.patient_id
         AND p.created_by IS NULL
         AND p.provenance = 'card_verified'
     )
  THEN
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.reject_self_registration_delivery() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reject_self_registration_delivery()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS reject_self_registration_delivery_trg
  ON public.sms_deliveries;
CREATE TRIGGER reject_self_registration_delivery_trg
  BEFORE INSERT ON public.sms_deliveries
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_self_registration_delivery();

ALTER FUNCTION public.claim_sms_delivery(
  uuid,
  public.sms_delivery_kind,
  text,
  integer
) RENAME TO claim_sms_delivery_impl;

REVOKE ALL ON FUNCTION public.claim_sms_delivery_impl(
  uuid,
  public.sms_delivery_kind,
  text,
  integer
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.claim_sms_delivery(
  p_patient_id uuid,
  p_kind public.sms_delivery_kind,
  p_phone_last4 text DEFAULT NULL,
  p_lease_seconds integer DEFAULT 120
) RETURNS TABLE(delivery_id uuid, claim_token uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
  IF p_kind = 'registration'
     AND EXISTS (
       SELECT 1
       FROM public.patients AS p
       WHERE p.id = p_patient_id
         AND p.created_by IS NULL
         AND p.provenance = 'card_verified'
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
$$;

ALTER FUNCTION public.claim_sms_delivery(
  uuid,
  public.sms_delivery_kind,
  text,
  integer
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_sms_delivery(
  uuid,
  public.sms_delivery_kind,
  text,
  integer
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_sms_delivery(
  uuid,
  public.sms_delivery_kind,
  text,
  integer
) TO authenticated, service_role;

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
AS $$
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
  LEFT JOIN public.camps AS c ON c.id = p.camp_id
  LEFT JOIN public.camp_days AS d ON d.id = p.camp_day_id
  WHERE p.id = p_patient_id
    AND NOT (
      p.created_by IS NULL
      AND p.provenance = 'card_verified'
    );
END;
$$;

ALTER FUNCTION public.patient_registration_notify_fields(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.patient_registration_notify_fields(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.patient_registration_notify_fields(uuid)
  TO authenticated, service_role;
