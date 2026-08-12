-- Fix PL/pgSQL ambiguity: RETURNS TABLE(id …) makes bare `id` in the body
-- refer to both the output column and camps.id (error 42702).

CREATE OR REPLACE FUNCTION public.desk_waiting_queue(
  p_camp_id uuid,
  p_limit integer DEFAULT 100
) RETURNS TABLE(
  id uuid,
  reg_no integer,
  full_name text,
  phone text,
  queued_at timestamptz,
  waiting_total bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 101);
BEGIN
  IF NOT public.is_staff() THEN
    RAISE EXCEPTION 'active registration staff required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.camps c WHERE c.id = p_camp_id AND c.is_active
  ) THEN
    RAISE EXCEPTION 'active camp required';
  END IF;

  RETURN QUERY
  WITH queue AS (
    SELECT p.id, p.reg_no, p.full_name, p.phone, p.queued_at,
      count(*) OVER ()::bigint AS exact_waiting_total
    FROM public.patients p
    WHERE p.camp_id = p_camp_id AND p.queue_status = 'waiting'
    ORDER BY p.queued_at NULLS LAST, p.reg_no, p.id
    LIMIT v_limit
  )
  SELECT q.id, q.reg_no, q.full_name, q.phone, q.queued_at,
    q.exact_waiting_total
  FROM queue q;
END;
$function$;

ALTER FUNCTION public.desk_waiting_queue(uuid, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.desk_waiting_queue(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.desk_waiting_queue(uuid, integer)
  TO authenticated, service_role, postgres;
