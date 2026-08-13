-- Readiness contract v3: prove the final provenance and unified KPI catalog.
-- Transform the already-complete v2 probe rather than duplicating its large
-- runtime-critical table, SMS, treatment, and grant inventory.
DO $migration$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(
    'public.readiness_catalog_probe()'::regprocedure
  )
  INTO v_definition;

  v_old := $old$      ('patients', 'provenance'),$old$;
  v_new := $new$      ('patients', 'provenance'),
      ('patients', 'phone_provenance'),$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'readiness v2 patient column anchor not found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $old$      ('staff_leaderboard'),$old$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'readiness v2 KPI function anchor not found';
  END IF;
  v_definition := replace(v_definition, v_old, '');

  v_old := $old$          AND pg_get_constraintdef(oid) NOT LIKE '%ekyc_verified%'$old$;
  v_new := $new$          AND pg_get_constraintdef(oid) NOT LIKE '%card_verified%'
          AND pg_get_constraintdef(oid) NOT LIKE '%ekyc_verified%'$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'readiness v2 provenance invariant anchor not found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $old$    'profiles_team_lead_fk',$old$;
  v_new := $new$    'patients_phone_provenance_current',
      EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'patients'
          AND column_name = 'phone_provenance'
          AND is_nullable = 'NO'
          AND column_default LIKE '%self_declared%'
      )
      AND EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.patients'::regclass
          AND conname = 'patients_phone_provenance_check'
          AND contype = 'c'
          AND convalidated
          AND pg_get_constraintdef(oid) LIKE '%self_declared%'
      ),
    'staff_kpi_single_contract',
      (
        SELECT count(*) = 1
          AND bool_and(
            p.oid = to_regprocedure(
              'public.staff_person_kpis(uuid,text,uuid,timestamptz,text)'
            )
          )
        FROM pg_proc AS p
        JOIN pg_namespace AS n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'staff_person_kpis'
      ),
    'staff_leaderboard_absent',
      to_regprocedure('public.staff_leaderboard(uuid,uuid)') IS NULL,
    'migration_head_current',
      public.latest_applied_migration() = '20260728118000',
    'profiles_team_lead_fk',$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'readiness v2 invariant insertion anchor not found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $old$    'staff_person_kpis_authenticated_execute',
      has_function_privilege(
        'authenticated',
        'public.staff_person_kpis(uuid,text,uuid,timestamptz)',
        'EXECUTE'
      ),
    'staff_leaderboard_authenticated_execute',
      has_function_privilege(
        'authenticated',
        'public.staff_leaderboard(uuid,uuid)',
        'EXECUTE'
      ),$old$;
  v_new := $new$    'staff_person_kpis_authenticated_execute',
      has_function_privilege(
        'authenticated',
        'public.staff_person_kpis(uuid,text,uuid,timestamptz,text)',
        'EXECUTE'
      ),
    'staff_person_kpis_anon_execute',
      has_function_privilege(
        'anon',
        'public.staff_person_kpis(uuid,text,uuid,timestamptz,text)',
        'EXECUTE'
      ),
    'staff_person_kpis_service_role_execute',
      has_function_privilege(
        'service_role',
        'public.staff_person_kpis(uuid,text,uuid,timestamptz,text)',
        'EXECUTE'
      ),
    'staff_leaderboard_authenticated_execute',
      to_regprocedure('public.staff_leaderboard(uuid,uuid)') IS NOT NULL,$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'readiness v2 KPI grant anchor not found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  EXECUTE v_definition;
END
$migration$;

COMMENT ON FUNCTION public.readiness_catalog_probe() IS
  'Service-only boolean catalog facts for readiness contract v3; contains no row data.';

ALTER FUNCTION public.readiness_catalog_probe() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.readiness_catalog_probe()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_catalog_probe()
  TO service_role, postgres;
