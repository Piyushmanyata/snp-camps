-- Match the display-name trigram index expression exactly to the desk query.

DROP INDEX IF EXISTS public.patients_display_name_trgm_idx;
CREATE INDEX patients_display_name_trgm_idx
  ON public.patients
  USING gin (
    (lower(btrim(coalesce(display_name, '')))) extensions.gin_trgm_ops
  )
  WHERE display_name IS NOT NULL;

DO $migration$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(
    'public.readiness_catalog_probe()'::regprocedure
  ) INTO v_definition;

  v_old := $old$public.latest_applied_migration() = '20260729103000'$old$;
  v_new := $new$public.latest_applied_migration() = '20260729104500'$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'readiness migration head anchor not found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  EXECUTE v_definition;
END
$migration$;
