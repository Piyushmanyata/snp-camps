-- Readiness contract v2: prove the runtime schema, trust boundaries, workflow
-- invariants, and retired surfaces introduced through the production audit.
CREATE OR REPLACE FUNCTION public.readiness_catalog_probe()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_tables jsonb;
  v_columns jsonb;
  v_functions jsonb;
  v_invariants jsonb;
  v_grants jsonb;
  v_states jsonb;
  v_kinds jsonb;
BEGIN
  SELECT jsonb_object_agg(expected.name, to_regclass('public.' || expected.name) IS NOT NULL)
  INTO v_tables
  FROM (
    VALUES
      ('patients'),
      ('persons'),
      ('camps'),
      ('camp_days'),
      ('profiles'),
      ('sms_deliveries'),
      ('prescriptions'),
      ('treatment_orders'),
      ('public_rate_limit_buckets')
  ) AS expected(name);

  SELECT jsonb_object_agg(
    expected.table_name || '.' || expected.column_name,
    EXISTS (
      SELECT 1
      FROM information_schema.columns AS c
      WHERE c.table_schema = 'public'
        AND c.table_name = expected.table_name
        AND c.column_name = expected.column_name
    )
  )
  INTO v_columns
  FROM (
    VALUES
      ('patients', 'id'),
      ('patients', 'status_token'),
      ('patients', 'queue_status'),
      ('patients', 'queued_at'),
      ('patients', 'reg_no'),
      ('patients', 'camp_id'),
      ('patients', 'camp_day_id'),
      ('patients', 'full_name'),
      ('patients', 'display_name'),
      ('patients', 'person_id'),
      ('patients', 'provenance'),
      ('persons', 'id'),
      ('persons', 'reg_no'),
      ('persons', 'full_name'),
      ('persons', 'display_name'),
      ('persons', 'gender'),
      ('persons', 'date_of_birth'),
      ('persons', 'aadhaar_last4'),
      ('persons', 'duplicate_key'),
      ('persons', 'aadhaar_locked_at'),
      ('persons', 'name_locked_at'),
      ('camps', 'id'),
      ('camps', 'name'),
      ('camps', 'is_active'),
      ('camps', 'venue'),
      ('camp_days', 'id'),
      ('camp_days', 'camp_id'),
      ('camp_days', 'day_date'),
      ('camp_days', 'seat_limit'),
      ('camp_days', 'theatre_capacity'),
      ('profiles', 'id'),
      ('profiles', 'role'),
      ('profiles', 'disabled_at'),
      ('profiles', 'team_lead_id'),
      ('sms_deliveries', 'id'),
      ('sms_deliveries', 'patient_id'),
      ('sms_deliveries', 'kind'),
      ('sms_deliveries', 'state'),
      ('sms_deliveries', 'claim_token'),
      ('sms_deliveries', 'phone_last4'),
      ('sms_deliveries', 'attempt_count'),
      ('sms_deliveries', 'dispatch_started_at'),
      ('sms_deliveries', 'updated_at'),
      ('prescriptions', 'id'),
      ('prescriptions', 'patient_id'),
      ('prescriptions', 'camp_id'),
      ('prescriptions', 'doctor_id'),
      ('treatment_orders', 'id'),
      ('treatment_orders', 'patient_id'),
      ('treatment_orders', 'camp_id'),
      ('treatment_orders', 'prescription_id'),
      ('treatment_orders', 'kind'),
      ('treatment_orders', 'status'),
      ('treatment_orders', 'scheduled_camp_day_id'),
      ('treatment_orders', 'source'),
      ('treatment_orders', 'created_by'),
      ('public_rate_limit_buckets', 'scope'),
      ('public_rate_limit_buckets', 'key_hash'),
      ('public_rate_limit_buckets', 'window_started_at'),
      ('public_rate_limit_buckets', 'attempts'),
      ('public_rate_limit_buckets', 'expires_at')
  ) AS expected(table_name, column_name);

  SELECT jsonb_object_agg(
    expected.name,
    EXISTS (
      SELECT 1
      FROM pg_proc AS p
      JOIN pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = expected.name
    )
  )
  INTO v_functions
  FROM (
    VALUES
      ('latest_applied_migration'),
      ('readiness_catalog_probe'),
      ('patient_status_by_token'),
      ('upsert_camp_day'),
      ('register_patient_idempotent'),
      ('check_in_patient'),
      ('lookup_patient_status_token'),
      ('consume_public_rate_limit'),
      ('active_registration_id'),
      ('assign_patient_doctor'),
      ('doctor_submit_prescription'),
      ('resolve_treatment_order'),
      ('counter_create_and_fulfill_order'),
      ('staff_person_kpis'),
      ('staff_leaderboard'),
      ('claim_sms_delivery'),
      ('mark_sms_dispatch_started'),
      ('complete_sms_delivery'),
      ('patient_registration_notify_fields')
  ) AS expected(name);

  v_invariants := jsonb_build_object(
    'patients_camp_reg_no_unique',
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.patients'::regclass
          AND conname = 'patients_camp_reg_no_key'
          AND contype = 'u'
          AND convalidated
      ),
    'patients_person_camp_unique',
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.patients'::regclass
          AND conname = 'patients_person_camp_key'
          AND contype = 'u'
          AND convalidated
      ),
    'patients_person_id_not_null',
      EXISTS (
        SELECT 1
        FROM pg_attribute
        WHERE attrelid = 'public.patients'::regclass
          AND attname = 'person_id'
          AND attnotnull
          AND NOT attisdropped
      ),
    'patients_provenance_current',
      EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.patients'::regclass
          AND conname = 'patients_provenance_check'
          AND convalidated
          AND pg_get_constraintdef(oid) LIKE '%self_declared%'
          AND pg_get_constraintdef(oid) LIKE '%card_verified%'
          AND pg_get_constraintdef(oid) NOT LIKE '%ekyc_verified%'
      ),
    'retired_ekyc_storage_absent',
      NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'patients'
          AND column_name IN (
            'aadhaar_hash',
            'aadhaar_verified_at',
            'aadhaar_kyc_ref'
          )
      ),
    'register_rpc_supported_signatures_only',
      (
        SELECT count(*) = 2
          AND bool_and(
            pg_get_function_arguments(p.oid) NOT ILIKE '%aadhaar_hash%'
            AND pg_get_function_arguments(p.oid) NOT ILIKE '%aadhaar_verified_at%'
            AND pg_get_function_arguments(p.oid) NOT ILIKE '%aadhaar_kyc_ref%'
          )
        FROM pg_proc AS p
        JOIN pg_namespace AS n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'register_patient_idempotent'
      ),
    'profiles_team_lead_fk',
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.profiles'::regclass
          AND conname = 'profiles_team_lead_id_fkey'
          AND contype = 'f'
          AND convalidated
      ),
    'team_membership_guards',
      (
        SELECT count(*) = 2
          AND bool_and(tgenabled <> 'D')
        FROM pg_trigger
        WHERE tgrelid = 'public.profiles'::regclass
          AND NOT tgisinternal
          AND tgname IN (
            'validate_profile_team_membership',
            'release_disabled_team_members'
          )
      ),
    'prescription_patient_scope_fk',
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.prescriptions'::regclass
          AND conname = 'prescriptions_patient_camp_fkey'
          AND contype = 'f'
          AND convalidated
      ),
    'treatment_order_patient_scope_fk',
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.treatment_orders'::regclass
          AND conname = 'treatment_orders_patient_camp_fkey'
          AND contype = 'f'
          AND convalidated
      ),
    'treatment_order_prescription_scope_fk',
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.treatment_orders'::regclass
          AND conname = 'treatment_orders_prescription_scope_fkey'
          AND contype = 'f'
          AND convalidated
      ),
    'treatment_order_state_integrity',
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.treatment_orders'::regclass
          AND conname = 'treatment_orders_state_integrity_check'
          AND contype = 'c'
          AND convalidated
      ),
    'treatment_order_attribution_columns_required',
      (
        SELECT count(*) = 2
          AND bool_and(is_nullable = 'NO')
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'treatment_orders'
          AND column_name IN ('source', 'created_by')
      )
      AND EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.treatment_orders'::regclass
          AND conname = 'treatment_orders_source_check'
          AND convalidated
      ),
    'treatment_order_attribution_guard',
      EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'public.treatment_orders'::regclass
          AND tgname = 'treatment_orders_set_attribution'
          AND NOT tgisinternal
          AND tgenabled <> 'D'
      ),
    'public_rate_limit_primary_key',
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.public_rate_limit_buckets'::regclass
          AND conname = 'public_rate_limit_buckets_pkey'
          AND contype = 'p'
          AND convalidated
      )
  );

  v_grants := jsonb_build_object(
    'patients_status_token_authenticated_select',
      has_column_privilege(
        'authenticated',
        'public.patients',
        'status_token',
        'SELECT'
      ),
    'patient_status_by_token_authenticated_execute',
      has_function_privilege(
        'authenticated',
        'public.patient_status_by_token(text)',
        'EXECUTE'
      ),
    'patient_status_by_token_anon_execute',
      has_function_privilege(
        'anon',
        'public.patient_status_by_token(text)',
        'EXECUTE'
      ),
    'patient_status_by_token_service_role_execute',
      has_function_privilege(
        'service_role',
        'public.patient_status_by_token(text)',
        'EXECUTE'
      ),
    'sms_deliveries_authenticated_select',
      has_table_privilege(
        'authenticated',
        'public.sms_deliveries',
        'SELECT'
      ),
    'claim_sms_delivery_service_role_execute',
      has_function_privilege(
        'service_role',
        'public.claim_sms_delivery(uuid,public.sms_delivery_kind,text,integer)',
        'EXECUTE'
      ),
    'complete_sms_delivery_service_role_execute',
      has_function_privilege(
        'service_role',
        'public.complete_sms_delivery(uuid,uuid,text,text,text)',
        'EXECUTE'
      ),
    'upsert_camp_day_authenticated_execute',
      has_function_privilege(
        'authenticated',
        'public.upsert_camp_day(uuid,date,integer,uuid,integer)',
        'EXECUTE'
      ),
    'check_in_patient_authenticated_execute',
      has_function_privilege(
        'authenticated',
        'public.check_in_patient(uuid,integer)',
        'EXECUTE'
      ),
    'register_patient_idempotent_authenticated_execute',
      has_function_privilege(
        'authenticated',
        'public.register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean,boolean,text,text,date,text)',
        'EXECUTE'
      ),
    'lookup_patient_status_token_anon_execute',
      has_function_privilege(
        'anon',
        'public.lookup_patient_status_token(integer,date)',
        'EXECUTE'
      ),
    'lookup_patient_status_token_authenticated_execute',
      has_function_privilege(
        'authenticated',
        'public.lookup_patient_status_token(integer,date)',
        'EXECUTE'
      ),
    'lookup_patient_status_token_service_role_execute',
      has_function_privilege(
        'service_role',
        'public.lookup_patient_status_token(integer,date)',
        'EXECUTE'
      ),
    'consume_public_rate_limit_anon_execute',
      has_function_privilege(
        'anon',
        'public.consume_public_rate_limit(text,text[],integer,integer)',
        'EXECUTE'
      ),
    'consume_public_rate_limit_authenticated_execute',
      has_function_privilege(
        'authenticated',
        'public.consume_public_rate_limit(text,text[],integer,integer)',
        'EXECUTE'
      ),
    'consume_public_rate_limit_service_role_execute',
      has_function_privilege(
        'service_role',
        'public.consume_public_rate_limit(text,text[],integer,integer)',
        'EXECUTE'
      ),
    'prescriptions_authenticated_insert',
      has_table_privilege('authenticated', 'public.prescriptions', 'INSERT'),
    'prescriptions_authenticated_update',
      has_table_privilege('authenticated', 'public.prescriptions', 'UPDATE'),
    'prescriptions_authenticated_delete',
      has_table_privilege('authenticated', 'public.prescriptions', 'DELETE'),
    'treatment_orders_authenticated_insert',
      has_table_privilege('authenticated', 'public.treatment_orders', 'INSERT'),
    'treatment_orders_authenticated_update',
      has_table_privilege('authenticated', 'public.treatment_orders', 'UPDATE'),
    'treatment_orders_authenticated_delete',
      has_table_privilege('authenticated', 'public.treatment_orders', 'DELETE'),
    'assign_patient_doctor_authenticated_execute',
      has_function_privilege(
        'authenticated',
        'public.assign_patient_doctor(uuid,integer,uuid)',
        'EXECUTE'
      ),
    'doctor_submit_prescription_authenticated_execute',
      has_function_privilege(
        'authenticated',
        'public.doctor_submit_prescription(uuid,text,text,text,text,text,text[])',
        'EXECUTE'
      ),
    'resolve_treatment_order_authenticated_execute',
      has_function_privilege(
        'authenticated',
        'public.resolve_treatment_order(uuid,text,date,text)',
        'EXECUTE'
      ),
    'counter_create_and_fulfill_order_authenticated_execute',
      has_function_privilege(
        'authenticated',
        'public.counter_create_and_fulfill_order(uuid,text[])',
        'EXECUTE'
      ),
    'staff_person_kpis_authenticated_execute',
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
      ),
    'mark_sms_dispatch_started_authenticated_execute',
      has_function_privilege(
        'authenticated',
        'public.mark_sms_dispatch_started(uuid,uuid)',
        'EXECUTE'
      ),
    'mark_sms_dispatch_started_service_role_execute',
      has_function_privilege(
        'service_role',
        'public.mark_sms_dispatch_started(uuid,uuid)',
        'EXECUTE'
      ),
    'patient_registration_notify_fields_authenticated_execute',
      has_function_privilege(
        'authenticated',
        'public.patient_registration_notify_fields(uuid)',
        'EXECUTE'
      ),
    'latest_applied_migration_service_role_execute',
      has_function_privilege(
        'service_role',
        'public.latest_applied_migration()',
        'EXECUTE'
      )
  );

  SELECT jsonb_object_agg(
    expected.name,
    EXISTS (
      SELECT 1
      FROM pg_enum AS e
      JOIN pg_type AS t ON t.oid = e.enumtypid
      JOIN pg_namespace AS n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
        AND t.typname = 'sms_delivery_state'
        AND e.enumlabel = expected.name
    )
  )
  INTO v_states
  FROM (
    VALUES
      ('pending'),
      ('sending'),
      ('sent'),
      ('failed'),
      ('ambiguous')
  ) AS expected(name);

  SELECT jsonb_object_agg(
    expected.name,
    EXISTS (
      SELECT 1
      FROM pg_enum AS e
      JOIN pg_type AS t ON t.oid = e.enumtypid
      JOIN pg_namespace AS n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
        AND t.typname = 'sms_delivery_kind'
        AND e.enumlabel = expected.name
    )
  )
  INTO v_kinds
  FROM (
    VALUES
      ('registration'),
      ('reminder'),
      ('spectacles_deferral'),
      ('surgery_deferral')
  ) AS expected(name);

  RETURN jsonb_build_object(
    'tables', v_tables,
    'columns', v_columns,
    'functions', v_functions,
    'invariants', v_invariants,
    'grants', v_grants,
    'publication', jsonb_build_object(
      'patients_in_supabase_realtime',
      EXISTS (
        SELECT 1
        FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'patients'
      )
    ),
    'sms', jsonb_build_object(
      'table', to_regclass('public.sms_deliveries') IS NOT NULL,
      'states', v_states,
      'kinds', v_kinds,
      'claim_fn',
        to_regprocedure(
          'public.claim_sms_delivery(uuid,public.sms_delivery_kind,text,integer)'
        ) IS NOT NULL,
      'complete_fn',
        to_regprocedure(
          'public.complete_sms_delivery(uuid,uuid,text,text,text)'
        ) IS NOT NULL
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.readiness_catalog_probe() IS
  'Service-only boolean catalog facts for readiness contract v2; contains no row data.';

ALTER FUNCTION public.readiness_catalog_probe() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.readiness_catalog_probe()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_catalog_probe()
  TO service_role, postgres;
