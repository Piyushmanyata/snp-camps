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

  SELECT d.printing_open
  INTO v_open
  FROM public.camp_days AS d
  WHERE d.id = r.camp_day_id
  FOR UPDATE;

  IF v_open IS NOT TRUE THEN
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

  SELECT d.printing_open
  INTO v_open
  FROM public.camp_days AS d
  WHERE d.id = r.camp_day_id
  FOR UPDATE;

  IF v_open IS NOT TRUE THEN
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

ALTER FUNCTION public.mark_patient_printed(uuid, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mark_patient_printed(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_patient_printed(uuid, integer) TO authenticated, service_role;

ALTER FUNCTION public.mark_seen(uuid, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mark_seen(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_seen(uuid, integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.latest_applied_migration()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$ SELECT '20260827140000'::text $$;
