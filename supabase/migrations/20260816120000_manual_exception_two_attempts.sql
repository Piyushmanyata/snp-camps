ALTER TABLE public.patients DROP CONSTRAINT IF EXISTS patients_manual_exception_check;
ALTER TABLE public.patients ADD CONSTRAINT patients_manual_exception_check CHECK (
  (provenance <> 'manual_exception' AND manual_exception_actor IS NULL
    AND manual_exception_at IS NULL AND manual_exception_reason IS NULL
    AND failed_scan_attempts IS NULL)
  OR
  (provenance = 'manual_exception' AND manual_exception_actor IS NOT NULL
    AND manual_exception_at IS NOT NULL
    AND nullif(btrim(manual_exception_reason), '') IS NOT NULL
    AND failed_scan_attempts >= 2)
);

CREATE OR REPLACE FUNCTION public.register_manual_exception(
  p_request_id uuid,
  p_camp_id uuid,
  p_camp_day_id uuid,
  p_full_name text,
  p_display_name text,
  p_gender text,
  p_age integer,
  p_address text,
  p_phone text,
  p_reason text,
  p_failed_scan_attempts integer,
  p_actor_id uuid
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
SET search_path TO pg_catalog, public
AS $$
DECLARE
  v_role public.user_role;
  v_patient_id uuid;
BEGIN
  SELECT pr.role INTO v_role
  FROM public.profiles AS pr
  WHERE pr.id = p_actor_id AND pr.disabled_at IS NULL;

  IF v_role IS NULL OR v_role NOT IN (
    'admin'::public.user_role,
    'team_lead'::public.user_role,
    'volunteer'::public.user_role
  ) THEN
    RAISE EXCEPTION 'manual exception requires staff';
  END IF;

  IF p_failed_scan_attempts < 2
     OR nullif(btrim(p_reason), '') IS NULL
     OR p_phone !~ '^[6-9][0-9]{9}$'
     OR p_phone ~ '^([0-9])\1{9}$'
  THEN
    RAISE EXCEPTION 'invalid manual exception evidence';
  END IF;

  SELECT r.id INTO v_patient_id
  FROM public.register_patient_idempotent(
    p_request_id, p_camp_id, p_full_name, p_gender, p_age, p_address, p_phone,
    null, null, null, p_actor_id, p_camp_day_id, false, false, false,
    'self_declared', null, null, p_display_name
  ) AS r;

  UPDATE public.patients AS p SET
    provenance = 'manual_exception',
    manual_exception_actor = p_actor_id,
    manual_exception_at = now(),
    manual_exception_reason = left(btrim(p_reason), 500),
    failed_scan_attempts = p_failed_scan_attempts
  WHERE p.id = v_patient_id;

  RETURN QUERY
  SELECT
    p.id,
    p.reg_no,
    p.full_name,
    p.camp_day_id,
    d.day_date,
    p.queue_status
  FROM public.patients AS p
  JOIN public.camp_days AS d ON d.id = p.camp_day_id
  WHERE p.id = v_patient_id;
END;
$$;

COMMENT ON FUNCTION public.register_manual_exception(
  uuid, uuid, uuid, text, text, text, integer, text, text, text, integer, uuid
) IS
  'Registration Staff manual exception after two failed scans. Returns narrow projection (id, reg_no, full_name, camp_day_id, day_date, queue_status).';

CREATE OR REPLACE FUNCTION public.latest_applied_migration()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$ SELECT '20260816120000'::text $$;
