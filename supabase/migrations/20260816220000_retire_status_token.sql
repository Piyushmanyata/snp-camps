REVOKE ALL ON FUNCTION public.patient_status_by_token(text) FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION IF EXISTS public.patient_status_by_token(text);

REVOKE ALL ON FUNCTION public.lookup_patient_status_token(integer, date) FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION IF EXISTS public.lookup_patient_status_token(integer, date);

DROP FUNCTION IF EXISTS public.patient_registration_notify_fields(uuid);

CREATE FUNCTION public.patient_registration_notify_fields(
  p_patient_id uuid
) RETURNS TABLE(
  id uuid,
  reg_no integer,
  phone text,
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

ALTER TABLE public.patients DROP COLUMN IF EXISTS status_token;

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
  v := jsonb_set(v, '{functions}', (coalesce(v->'functions', '{}'::jsonb) - 'patient_status_by_token' - 'lookup_patient_status_token') || jsonb_build_object(
    'set_camp_day_printing_open',
    to_regprocedure('public.set_camp_day_printing_open(uuid,boolean)') IS NOT NULL,
    'confirm_manual_exception_aadhaar',
    to_regprocedure('public.confirm_manual_exception_aadhaar(uuid,text,text,text,date,text,text,text,boolean,uuid,text)') IS NOT NULL
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
    )
  ));
  RETURN v;
END;
$function$;

CREATE OR REPLACE FUNCTION public.latest_applied_migration()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$ SELECT '20260816220000'::text $$;
