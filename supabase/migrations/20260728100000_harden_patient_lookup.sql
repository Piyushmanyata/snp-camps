-- Harden #114 patient lookup at the database boundary.
-- The public Next.js route calls this function with the service-role client.
-- Browser roles must never be able to bypass that route's abuse controls.

CREATE OR REPLACE FUNCTION public.lookup_patient_status_token(
  p_reg_no integer,
  p_date_of_birth date
) RETURNS TABLE(status_token text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
  SELECT p.status_token
  FROM public.patients AS p
  JOIN public.persons AS pe ON pe.id = p.person_id
  WHERE p.reg_no = p_reg_no
    AND pe.date_of_birth = p_date_of_birth
  LIMIT 1
$$;

ALTER FUNCTION public.lookup_patient_status_token(integer, date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.lookup_patient_status_token(integer, date)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lookup_patient_status_token(integer, date)
  TO service_role;

COMMENT ON FUNCTION public.lookup_patient_status_token(integer, date) IS
  'Service-only exact registration-number and Person-DOB lookup for the public status route.';
