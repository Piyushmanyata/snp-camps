-- The application now sends card_scanned. Remove the temporary rollout input
-- alias and the legacy leaderboard wrapper only after the new application is
-- deployed. Migrations 115-117 must remain compatible with the previous app.
DROP FUNCTION public.staff_leaderboard(uuid, uuid);

DO $migration$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(
    'public.register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean,boolean,text,text,date,text)'::regprocedure
  )
  INTO v_definition;

  v_old := $old$v_provenance text := CASE
    WHEN lower(btrim(coalesce(p_provenance, 'self_declared'))) = 'card_verified'
      THEN 'card_scanned'
    ELSE lower(btrim(coalesce(p_provenance, 'self_declared')))
  END;$old$;
  v_new := $new$v_provenance text := lower(
    btrim(coalesce(p_provenance, 'self_declared'))
  );$new$;

  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'Legacy provenance rollout normalizer not found';
  END IF;

  EXECUTE replace(v_definition, v_old, v_new);

  IF EXISTS (
    SELECT 1
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND p.proname <> 'readiness_catalog_probe'
      AND pg_get_functiondef(p.oid) LIKE '%card_verified%'
  ) THEN
    RAISE EXCEPTION 'Retired card_verified semantics remain after rollout';
  END IF;
END
$migration$;
