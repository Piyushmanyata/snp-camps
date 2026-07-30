-- #68 — Runtime-critical catalog probe for fail-closed readiness.
-- Returns observable facts only (booleans / names). No connection strings,
-- SQL text dumps, secrets, Auth records, or patient data.
-- EXECUTE: service_role only (health path uses createServiceRoleClient).

CREATE OR REPLACE FUNCTION public.readiness_catalog_probe()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_tables jsonb := '{}'::jsonb;
  v_columns jsonb := '{}'::jsonb;
  v_functions jsonb := '{}'::jsonb;
  v_grants jsonb := '{}'::jsonb;
  v_states jsonb := '{}'::jsonb;
  v_kinds jsonb := '{}'::jsonb;
  v_tbl text;
  v_col text;
  v_fn text;
  v_state text;
  v_kind text;
  v_patients_in_rt boolean;
  v_required_tables text[] := ARRAY[
    'patients', 'camps', 'camp_days', 'profiles', 'sms_deliveries'
  ];
  v_required_fns text[] := ARRAY[
    'latest_applied_migration',
    'readiness_catalog_probe',
    'patient_status_by_token',
    'upsert_camp_day',
    'register_patient_idempotent',
    'check_in_patient',
    'claim_sms_delivery',
    'complete_sms_delivery'
  ];
  v_sms_states text[] := ARRAY[
    'pending', 'sending', 'sent', 'failed', 'ambiguous'
  ];
  v_sms_kinds text[] := ARRAY['registration', 'reminder'];
BEGIN
  -- Tables
  FOREACH v_tbl IN ARRAY v_required_tables LOOP
    v_tables := v_tables || jsonb_build_object(
      v_tbl,
      to_regclass(format('public.%I', v_tbl)) IS NOT NULL
    );
  END LOOP;

  -- Critical columns (table.column → boolean)
  FOR v_tbl, v_col IN
    SELECT * FROM (VALUES
      ('patients', 'id'),
      ('patients', 'status_token'),
      ('patients', 'queue_status'),
      ('patients', 'queued_at'),
      ('patients', 'reg_no'),
      ('patients', 'camp_id'),
      ('patients', 'camp_day_id'),
      ('patients', 'full_name'),
      ('camps', 'id'),
      ('camps', 'name'),
      ('camps', 'is_active'),
      ('camps', 'venue'),
      ('camp_days', 'id'),
      ('camp_days', 'camp_id'),
      ('camp_days', 'day_date'),
      ('camp_days', 'seat_limit'),
      ('profiles', 'id'),
      ('profiles', 'disabled_at'),
      ('sms_deliveries', 'id'),
      ('sms_deliveries', 'patient_id'),
      ('sms_deliveries', 'kind'),
      ('sms_deliveries', 'state'),
      ('sms_deliveries', 'claim_token'),
      ('sms_deliveries', 'phone_last4'),
      ('sms_deliveries', 'attempt_count'),
      ('sms_deliveries', 'updated_at')
    ) AS t(tbl, col)
  LOOP
    v_columns := v_columns || jsonb_build_object(
      v_tbl || '.' || v_col,
      EXISTS (
        SELECT 1
        FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = v_tbl
          AND c.column_name = v_col
      )
    );
  END LOOP;

  -- Functions by name (signature-stable existence)
  FOREACH v_fn IN ARRAY v_required_fns LOOP
    v_functions := v_functions || jsonb_build_object(
      v_fn,
      EXISTS (
        SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = v_fn
      )
    );
  END LOOP;

  -- Grant / privilege facts (true = privilege present)
  v_grants := jsonb_build_object(
    'patients_status_token_authenticated_select',
    CASE
      WHEN to_regclass('public.patients') IS NULL THEN false
      ELSE has_column_privilege(
        'authenticated', 'public.patients', 'status_token', 'SELECT'
      )
    END,
    'patient_status_by_token_authenticated_execute',
    EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'patient_status_by_token'
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ),
    'patient_status_by_token_anon_execute',
    EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'patient_status_by_token'
        AND has_function_privilege('anon', p.oid, 'EXECUTE')
    ),
    'patient_status_by_token_service_role_execute',
    EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'patient_status_by_token'
        AND has_function_privilege('service_role', p.oid, 'EXECUTE')
    ),
    'sms_deliveries_authenticated_select',
    CASE
      WHEN to_regclass('public.sms_deliveries') IS NULL THEN false
      ELSE has_table_privilege('authenticated', 'public.sms_deliveries', 'SELECT')
    END,
    'claim_sms_delivery_service_role_execute',
    EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'claim_sms_delivery'
        AND has_function_privilege('service_role', p.oid, 'EXECUTE')
    ),
    'complete_sms_delivery_service_role_execute',
    EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'complete_sms_delivery'
        AND has_function_privilege('service_role', p.oid, 'EXECUTE')
    ),
    'upsert_camp_day_authenticated_execute',
    EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'upsert_camp_day'
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ),
    'check_in_patient_authenticated_execute',
    EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'check_in_patient'
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ),
    'register_patient_idempotent_authenticated_execute',
    EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'register_patient_idempotent'
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ),
    'latest_applied_migration_service_role_execute',
    EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'latest_applied_migration'
        AND has_function_privilege('service_role', p.oid, 'EXECUTE')
    )
  );

  -- Realtime publication: patients must be absent (#56)
  SELECT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'patients'
  ) INTO v_patients_in_rt;

  -- SMS ledger states / kinds
  FOREACH v_state IN ARRAY v_sms_states LOOP
    v_states := v_states || jsonb_build_object(
      v_state,
      EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public'
          AND t.typname = 'sms_delivery_state'
          AND e.enumlabel = v_state
      )
    );
  END LOOP;

  FOREACH v_kind IN ARRAY v_sms_kinds LOOP
    v_kinds := v_kinds || jsonb_build_object(
      v_kind,
      EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public'
          AND t.typname = 'sms_delivery_kind'
          AND e.enumlabel = v_kind
      )
    );
  END LOOP;

  RETURN jsonb_build_object(
    'tables', v_tables,
    'columns', v_columns,
    'functions', v_functions,
    'grants', v_grants,
    'publication', jsonb_build_object(
      'patients_in_supabase_realtime', coalesce(v_patients_in_rt, false)
    ),
    'sms', jsonb_build_object(
      'table', to_regclass('public.sms_deliveries') IS NOT NULL,
      'states', v_states,
      'kinds', v_kinds,
      'claim_fn', EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'claim_sms_delivery'
      ),
      'complete_fn', EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'complete_sms_delivery'
      )
    )
  );
END;
$$;

COMMENT ON FUNCTION public.readiness_catalog_probe() IS
  'Read-only catalog facts for fail-closed readiness (#68). No PHI/secrets/SQL text. service_role only.';

ALTER FUNCTION public.readiness_catalog_probe() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.readiness_catalog_probe() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_catalog_probe() TO service_role, postgres;
