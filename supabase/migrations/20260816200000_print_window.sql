ALTER TABLE public.camp_days
  ADD COLUMN IF NOT EXISTS printing_open boolean NOT NULL DEFAULT false;

DROP FUNCTION IF EXISTS public.camp_day_stats(uuid);

CREATE FUNCTION public.camp_day_stats(p_camp_id uuid DEFAULT NULL::uuid)
RETURNS TABLE(
  id uuid,
  camp_id uuid,
  day_date date,
  seat_limit integer,
  seats_taken integer,
  seats_left integer,
  is_full boolean,
  printing_open boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH target AS (
    SELECT coalesce(
      p_camp_id,
      (SELECT c.id FROM public.camps c WHERE c.is_active = true LIMIT 1)
    ) AS camp_id
  )
  SELECT
    d.id,
    d.camp_id,
    d.day_date,
    d.seat_limit,
    count(p.id)::integer AS seats_taken,
    greatest(d.seat_limit - count(p.id)::integer, 0) AS seats_left,
    (count(p.id)::integer >= d.seat_limit) AS is_full,
    d.printing_open
  FROM public.camp_days d
  CROSS JOIN target t
  LEFT JOIN public.patients p ON p.camp_day_id = d.id
  WHERE d.camp_id = t.camp_id
  GROUP BY d.id, d.camp_id, d.day_date, d.seat_limit, d.printing_open
  ORDER BY d.day_date;
$$;

ALTER FUNCTION public.camp_day_stats(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.camp_day_stats(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.camp_day_stats(uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.active_camp_snapshot()
RETURNS TABLE(
  id uuid,
  name text,
  venue text,
  camp_date date,
  days jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT
    c.id,
    c.name,
    c.venue,
    c.camp_date,
    coalesce(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', d.id,
            'camp_id', d.camp_id,
            'day_date', d.day_date,
            'seat_limit', d.seat_limit,
            'seats_taken', d.seats_taken,
            'seats_left', d.seats_left,
            'is_full', d.is_full,
            'printing_open', d.printing_open
          )
          ORDER BY d.day_date
        )
        FROM (
          SELECT
            cd.id,
            cd.camp_id,
            cd.day_date,
            cd.seat_limit,
            count(p.id)::integer AS seats_taken,
            greatest(cd.seat_limit - count(p.id)::integer, 0) AS seats_left,
            (count(p.id)::integer >= cd.seat_limit) AS is_full,
            cd.printing_open
          FROM public.camp_days cd
          LEFT JOIN public.patients p ON p.camp_day_id = cd.id
          WHERE cd.camp_id = c.id
          GROUP BY cd.id, cd.camp_id, cd.day_date, cd.seat_limit, cd.printing_open
        ) d
      ),
      '[]'::jsonb
    ) AS days
  FROM public.camps c
  WHERE c.is_active = true
  LIMIT 1;
$$;

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

  UPDATE public.camp_days AS d
  SET printing_open = coalesce(p_open, false)
  WHERE d.id = p_day_id
  RETURNING d.* INTO r;

  IF r.id IS NULL THEN
    RAISE EXCEPTION 'Day not found';
  END IF;

  RETURN r;
END;
$function$;

ALTER FUNCTION public.set_camp_day_printing_open(uuid, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_camp_day_printing_open(uuid, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_camp_day_printing_open(uuid, boolean)
  TO authenticated, service_role;

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

  IF NOT EXISTS (
    SELECT 1 FROM public.camps AS c WHERE c.id = r.camp_id AND c.is_active
  ) THEN
    RAISE EXCEPTION 'Patient belongs to an inactive camp';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.camp_days AS d
    WHERE d.id = r.camp_day_id
      AND d.printing_open
      AND d.day_date = (timezone('Asia/Kolkata', now()))::date
  ) THEN
    RAISE EXCEPTION 'PRINT_WINDOW_CLOSED';
  END IF;

  v_already := r.printed_at IS NOT NULL;

  IF NOT v_already THEN
    UPDATE public.patients AS p
    SET printed_at = now(),
        checked_in_by = coalesce(p.checked_in_by, (SELECT auth.uid()))
    WHERE p.id = r.id
    RETURNING p.* INTO r;
  END IF;

  RETURN QUERY
  SELECT r.id, r.reg_no, r.full_name, r.queue_status, v_already;
END;
$function$;

ALTER FUNCTION public.readiness_catalog_probe()
  RENAME TO readiness_catalog_probe_20260813;

REVOKE ALL ON FUNCTION public.readiness_catalog_probe_20260813()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_catalog_probe_20260813()
  TO postgres;

CREATE FUNCTION public.readiness_catalog_probe()
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
  v := jsonb_set(
    v,
    '{columns}',
    coalesce(v->'columns', '{}'::jsonb) || jsonb_build_object(
      'camp_days.printing_open',
      EXISTS (
        SELECT 1
        FROM information_schema.columns AS c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'camp_days'
          AND c.column_name = 'printing_open'
      )
    )
  );
  v := jsonb_set(
    v,
    '{functions}',
    coalesce(v->'functions', '{}'::jsonb) || jsonb_build_object(
      'set_camp_day_printing_open',
      to_regprocedure('public.set_camp_day_printing_open(uuid,boolean)') IS NOT NULL
    )
  );
  v := jsonb_set(
    v,
    '{grants}',
    coalesce(v->'grants', '{}'::jsonb) || jsonb_build_object(
      'set_camp_day_printing_open_authenticated_execute',
      CASE
        WHEN to_regprocedure('public.set_camp_day_printing_open(uuid,boolean)') IS NOT NULL
        THEN has_function_privilege(
          'authenticated',
          'public.set_camp_day_printing_open(uuid,boolean)',
          'EXECUTE'
        )
        ELSE false
      END,
      'set_camp_day_printing_open_anon_execute',
      CASE
        WHEN to_regprocedure('public.set_camp_day_printing_open(uuid,boolean)') IS NOT NULL
        THEN has_function_privilege(
          'anon',
          'public.set_camp_day_printing_open(uuid,boolean)',
          'EXECUTE'
        )
        ELSE false
      END
    )
  );
  RETURN v;
END;
$function$;

ALTER FUNCTION public.readiness_catalog_probe() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.readiness_catalog_probe()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_catalog_probe()
  TO service_role, postgres;

CREATE OR REPLACE FUNCTION public.latest_applied_migration()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$ SELECT '20260816200000'::text $$;

ALTER FUNCTION public.latest_applied_migration() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.latest_applied_migration()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.latest_applied_migration()
  TO service_role, postgres;
