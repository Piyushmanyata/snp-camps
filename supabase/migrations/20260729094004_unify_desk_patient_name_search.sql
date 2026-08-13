-- Unified desk lookup: registration number and name now share the scanner's
-- read-only review path. Name search covers every queue state so staff can
-- print/reprint or mark seen from one surface.

CREATE FUNCTION public.search_desk_patients(
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
    SELECT 1
    FROM public.camps AS c
    WHERE c.id = p_camp_id
      AND c.is_active
  ) THEN
    RAISE EXCEPTION 'No active camp';
  END IF;

  v_q := lower(btrim(regexp_replace(coalesce(p_query, ''), '\s+', ' ', 'g')));
  IF length(v_q) < 2 THEN
    RETURN;
  END IF;

  v_lim := greatest(1, least(coalesce(p_limit, 10), 10));

  RETURN QUERY
  SELECT
    p.id,
    p.reg_no,
    p.full_name,
    p.age,
    p.address,
    p.queue_status
  FROM public.patients AS p
  WHERE p.camp_id = p_camp_id
    AND (
      p.full_name_normalized LIKE v_q || '%'
      OR (
        length(v_q) >= 3
        AND (
          similarity(p.full_name_normalized, v_q) >= 0.35
          OR word_similarity(v_q, p.full_name_normalized) >= 0.40
        )
      )
    )
  ORDER BY
    CASE
      WHEN p.full_name_normalized LIKE v_q || '%' THEN 0
      ELSE 1
    END,
    greatest(
      similarity(p.full_name_normalized, v_q),
      word_similarity(v_q, p.full_name_normalized)
    ) DESC,
    CASE p.queue_status
      WHEN 'waiting'::public.queue_status THEN 0
      WHEN 'registered'::public.queue_status THEN 1
      ELSE 2
    END,
    p.full_name_normalized,
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
  'Staff-only, read-only active-camp name search for the unified scan/type desk. Returns bounded disambiguation fields across registered, waiting, and seen states.';

-- Supabase advisor: cover audit-user foreign keys without changing behavior.
CREATE INDEX IF NOT EXISTS patients_aadhaar_duplicate_override_by_idx
  ON public.patients (aadhaar_duplicate_override_by);
CREATE INDEX IF NOT EXISTS patients_likely_duplicate_override_by_idx
  ON public.patients (likely_duplicate_override_by);

-- Keep readiness fail-closed: inventory the new RPC/grants and advance the
-- expected migration head in the database-side probe.
DO $migration$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(
    'public.readiness_catalog_probe()'::regprocedure
  ) INTO v_definition;

  v_old := $old$('camp_queue_counts')$old$;
  v_new := $new$('camp_queue_counts'),
      ('search_desk_patients')$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'readiness function inventory anchor not found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $old$'latest_applied_migration_service_role_execute',$old$;
  v_new := $new$'search_desk_patients_authenticated_execute',
      has_function_privilege('authenticated', 'public.search_desk_patients(uuid,text,integer)', 'EXECUTE'),
    'search_desk_patients_anon_execute',
      has_function_privilege('anon', 'public.search_desk_patients(uuid,text,integer)', 'EXECUTE'),
    'latest_applied_migration_service_role_execute',$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'readiness grant inventory anchor not found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $old$public.latest_applied_migration() = '20260729075022'$old$;
  v_new := $new$public.latest_applied_migration() = '20260729094004'$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'readiness migration head anchor not found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  EXECUTE v_definition;
END
$migration$;
