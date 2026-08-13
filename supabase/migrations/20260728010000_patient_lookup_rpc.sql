-- #114 — Patient lookup RPC (reg_no + date_of_birth -> status_token)
-- Rate-limited public lookup that returns status_token without exposing PHI or enumeration oracle.

CREATE OR REPLACE FUNCTION public.lookup_patient_status_token(
  p_reg_no integer,
  p_date_of_birth date
) RETURNS TABLE(status_token text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
  IF p_reg_no IS NULL OR p_date_of_birth IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT p.status_token
  FROM public.patients p
  LEFT JOIN public.persons pe ON pe.id = p.person_id
  WHERE p.reg_no = p_reg_no
    AND (pe.date_of_birth = p_date_of_birth OR p.created_at::date = p_date_of_birth)
  LIMIT 1;
END;
$$;

ALTER FUNCTION public.lookup_patient_status_token(integer, date) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.lookup_patient_status_token(integer, date) TO anon, authenticated, service_role;
