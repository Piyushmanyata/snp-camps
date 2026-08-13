-- Let the unified desk find the Latin display name captured for patients whose
-- identity name uses another script. Keep the original name searchable too.

CREATE INDEX IF NOT EXISTS patients_display_name_trgm_idx
  ON public.patients
  USING gin ((lower(btrim(display_name))) extensions.gin_trgm_ops)
  WHERE display_name IS NOT NULL;

CREATE OR REPLACE FUNCTION public.search_desk_patients(
  p_camp_id uuid,
  p_query text,
  p_limit integer DEFAULT 10
) RETURNS TABLE(
  id uuid,
  reg_no integer,
  full_name text,
  age integer,
  address text,
  queue_status public.queue_status
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $function$
DECLARE
  v_q text;
  v_lim integer;
BEGIN
  IF NOT public.is_staff() THEN
    RAISE EXCEPTION 'staff only' USING ERRCODE = '42501';
  END IF;

  IF p_camp_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.camps AS c
    WHERE c.id = p_camp_id AND c.is_active
  ) THEN
    RAISE EXCEPTION 'No active camp';
  END IF;

  v_q := lower(btrim(regexp_replace(coalesce(p_query, ''), '\s+', ' ', 'g')));
  IF length(v_q) < 2 THEN
    RETURN;
  END IF;
  v_lim := greatest(1, least(coalesce(p_limit, 10), 10));

  RETURN QUERY
  WITH candidates AS (
    SELECT
      p.*,
      lower(btrim(coalesce(p.display_name, ''))) AS display_name_normalized
    FROM public.patients AS p
    WHERE p.camp_id = p_camp_id
  )
  SELECT
    p.id,
    p.reg_no,
    coalesce(nullif(btrim(p.display_name), ''), p.full_name),
    p.age,
    p.address,
    p.queue_status
  FROM candidates AS p
  WHERE
    p.full_name_normalized LIKE v_q || '%'
    OR p.display_name_normalized LIKE v_q || '%'
    OR (
      length(v_q) >= 3
      AND (
        similarity(p.full_name_normalized, v_q) >= 0.35
        OR word_similarity(v_q, p.full_name_normalized) >= 0.40
        OR similarity(p.display_name_normalized, v_q) >= 0.35
        OR word_similarity(v_q, p.display_name_normalized) >= 0.40
      )
    )
  ORDER BY
    CASE
      WHEN p.full_name_normalized LIKE v_q || '%'
        OR p.display_name_normalized LIKE v_q || '%'
      THEN 0
      ELSE 1
    END,
    greatest(
      similarity(p.full_name_normalized, v_q),
      word_similarity(v_q, p.full_name_normalized),
      similarity(p.display_name_normalized, v_q),
      word_similarity(v_q, p.display_name_normalized)
    ) DESC,
    CASE p.queue_status
      WHEN 'waiting'::public.queue_status THEN 0
      WHEN 'registered'::public.queue_status THEN 1
      ELSE 2
    END,
    coalesce(nullif(p.display_name_normalized, ''), p.full_name_normalized),
    p.reg_no
  LIMIT v_lim;
END;
$function$;

ALTER FUNCTION public.search_desk_patients(uuid, text, integer)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.search_desk_patients(uuid, text, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_desk_patients(uuid, text, integer)
  TO authenticated, service_role;
COMMENT ON FUNCTION public.search_desk_patients(uuid, text, integer) IS
  'Staff-only, read-only active-camp name search for the unified scan/type desk. Searches identity and Latin display names across all queue states.';

DO $migration$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(
    'public.readiness_catalog_probe()'::regprocedure
  ) INTO v_definition;

  v_old := $old$public.latest_applied_migration() = '20260729094004'$old$;
  v_new := $new$public.latest_applied_migration() = '20260729103000'$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'readiness migration head anchor not found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  EXECUTE v_definition;
END
$migration$;
