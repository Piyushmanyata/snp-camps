CREATE OR REPLACE FUNCTION public.set_camp_day_printing_open(
  p_day_id uuid,
  p_open boolean
)
RETURNS public.camp_days
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  r public.camp_days;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only';
  END IF;
  IF p_day_id IS NULL THEN
    RAISE EXCEPTION 'day id required';
  END IF;

  SELECT *
  INTO r
  FROM public.camp_days AS d
  WHERE d.id = p_day_id
  FOR UPDATE;

  IF r.id IS NULL THEN
    RAISE EXCEPTION 'Day not found';
  END IF;

  UPDATE public.camp_days AS d
  SET printing_open = coalesce(p_open, false)
  WHERE d.id = p_day_id
  RETURNING d.* INTO r;

  RETURN r;
END;
$function$;

ALTER FUNCTION public.set_camp_day_printing_open(uuid, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_camp_day_printing_open(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_camp_day_printing_open(uuid, boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.latest_applied_migration()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$ SELECT '20260827130000'::text $$;
