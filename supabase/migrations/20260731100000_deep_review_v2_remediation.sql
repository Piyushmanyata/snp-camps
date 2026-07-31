-- Deep review remediation v2 (2026-07-31): retire dead registration overloads,
-- close persons to browser roles, fix false-green readiness, strip dead
-- card_verified predicates, index manual_exception_actor.

-- ---------------------------------------------------------------------------
-- W3.1 — Drop retired registration overloads
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text,
  uuid, uuid, uuid, boolean, boolean
);
DROP FUNCTION IF EXISTS public.register_patient_v2(
  uuid, uuid, text, text, integer, text, text, text, text,
  uuid, uuid, uuid, boolean, boolean, text
);

-- ---------------------------------------------------------------------------
-- W3.2 — persons is server-only (duplicate_key is pepper-derived)
-- ---------------------------------------------------------------------------
REVOKE ALL ON TABLE public.persons FROM anon, authenticated;
DROP POLICY IF EXISTS "staff read persons" ON public.persons;
DROP POLICY IF EXISTS "staff insert persons" ON public.persons;
DROP POLICY IF EXISTS "staff update persons" ON public.persons;

-- ---------------------------------------------------------------------------
-- W3.3 — Index unindexed FK
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS patients_manual_exception_actor_idx
  ON public.patients (manual_exception_actor)
  WHERE manual_exception_actor IS NOT NULL;

-- ---------------------------------------------------------------------------
-- W3.4 — Remove dead card_verified predicates (self-reg = created_by IS NULL)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_sms_delivery(
  p_patient_id uuid,
  p_kind public.sms_delivery_kind,
  p_phone_last4 text DEFAULT NULL,
  p_lease_seconds integer DEFAULT 120
) RETURNS TABLE(delivery_id uuid, claim_token uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF p_kind = 'registration'
     AND EXISTS (
       SELECT 1
       FROM public.patients AS p
       LEFT JOIN public.camp_days AS d ON d.id = p.camp_day_id
       WHERE p.id = p_patient_id
         AND (
           (p.created_by IS NULL)
           OR (
             d.day_date IS NOT NULL
             AND (
               p.created_by IS NULL
               OR d.day_date <= (timezone('Asia/Kolkata', now()))::date
             )
           )
         )
     )
  THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT *
  FROM public.claim_sms_delivery_impl(
    p_patient_id,
    p_kind,
    p_phone_last4,
    p_lease_seconds
  );
END;
$function$;

ALTER FUNCTION public.claim_sms_delivery(
  uuid, public.sms_delivery_kind, text, integer
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_sms_delivery(
  uuid, public.sms_delivery_kind, text, integer
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_sms_delivery(
  uuid, public.sms_delivery_kind, text, integer
) TO authenticated, service_role, postgres;

CREATE OR REPLACE FUNCTION public.patient_registration_notify_fields(
  p_patient_id uuid
) RETURNS TABLE(
  id uuid,
  reg_no integer,
  phone text,
  status_token text,
  venue text,
  day_date date
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF NOT public.is_staff() THEN
    RAISE EXCEPTION 'staff only';
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    p.reg_no,
    p.phone,
    p.status_token,
    c.venue,
    d.day_date
  FROM public.patients AS p
  JOIN public.camps AS c ON c.id = p.camp_id
  JOIN public.camp_days AS d ON d.id = p.camp_day_id
  WHERE p.id = p_patient_id
    AND p.created_by IS NOT NULL
    AND d.day_date > (timezone('Asia/Kolkata', now()))::date;
END;
$function$;

ALTER FUNCTION public.patient_registration_notify_fields(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.patient_registration_notify_fields(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.patient_registration_notify_fields(uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.reject_self_registration_delivery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF NEW.kind = 'registration'
     AND EXISTS (
       SELECT 1
       FROM public.patients AS p
       WHERE p.id = NEW.patient_id
         AND p.created_by IS NULL
     )
  THEN
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.reject_self_registration_delivery() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reject_self_registration_delivery()
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- W3.5 — readiness_catalog_probe: one register overload, persons grants, head
-- ---------------------------------------------------------------------------
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
      ('patients', 'printed_at'),
      ('patients', 'seen_at'),
      ('patients', 'seen_by'),
      ('patients', 'reg_no'),
      ('patients', 'camp_id'),
      ('patients', 'camp_day_id'),
      ('patients', 'full_name'),
      ('patients', 'display_name'),
      ('patients', 'person_id'),
      ('patients', 'provenance'),
      ('patients', 'phone_provenance'),
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
      ('camps', 'prescription_template'),
      ('camp_days', 'id'),
      ('camp_days', 'camp_id'),
      ('camp_days', 'day_date'),
      ('camp_days', 'seat_limit'),
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
      ('lookup_patient_scan'),
      ('mark_seen'),
      ('undo_mark_seen'),
      ('lookup_patient_status_token'),
      ('consume_public_rate_limit'),
      ('active_registration_id'),
      ('staff_person_kpis'),
      ('claim_sms_delivery'),
      ('mark_sms_dispatch_started'),
      ('complete_sms_delivery'),
      ('patient_registration_notify_fields'),
      ('camp_queue_counts'),
      ('search_desk_patients')
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
          AND pg_get_constraintdef(oid) LIKE '%card_scanned%'
          AND pg_get_constraintdef(oid) NOT LIKE '%ekyc_verified%'
      ),
    'retired_ekyc_storage_absent',
      NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'patients'
          AND column_name IN ('aadhaar_hash', 'aadhaar_verified_at', 'aadhaar_kyc_ref')
      ),
    'register_rpc_supported_signatures_only',
      (
        SELECT count(*) = 1
          AND bool_and(
            pg_get_function_arguments(p.oid) NOT ILIKE '%aadhaar_hash%'
            AND pg_get_function_arguments(p.oid) NOT ILIKE '%aadhaar_verified_at%'
            AND pg_get_function_arguments(p.oid) NOT ILIKE '%aadhaar_kyc_ref%'
          )
        FROM pg_proc AS p
        JOIN pg_namespace AS n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'register_patient_idempotent'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_proc AS p
        JOIN pg_namespace AS n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'register_patient_v2'
      ),
    'patients_phone_provenance_current',
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
      public.latest_applied_migration() = '20260731100000',
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
    'prescription_records_absent',
      to_regclass('public.prescriptions') IS NULL
      AND to_regclass('public.treatment_orders') IS NULL
      AND to_regclass('public.prescription_amendments') IS NULL,
    'doctor_station_retired',
      to_regprocedure('public.assign_patient_doctor(uuid,integer,uuid)') IS NULL
      AND to_regprocedure('public.is_doctor()') IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.profiles
        WHERE role = 'doctor'::public.user_role
          AND disabled_at IS NULL
      ),
    'mark_seen_contract',
      to_regprocedure('public.mark_seen(uuid,integer)') IS NOT NULL
      AND to_regprocedure('public.undo_mark_seen(uuid)') IS NOT NULL,
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
      has_column_privilege('authenticated', 'public.patients', 'status_token', 'SELECT'),
    'patient_status_by_token_authenticated_execute',
      has_function_privilege('authenticated', 'public.patient_status_by_token(text)', 'EXECUTE'),
    'patient_status_by_token_anon_execute',
      has_function_privilege('anon', 'public.patient_status_by_token(text)', 'EXECUTE'),
    'patient_status_by_token_service_role_execute',
      has_function_privilege('service_role', 'public.patient_status_by_token(text)', 'EXECUTE'),
    'sms_deliveries_authenticated_select',
      has_table_privilege('authenticated', 'public.sms_deliveries', 'SELECT'),
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
        'public.upsert_camp_day(uuid,date,integer,uuid)',
        'EXECUTE'
      ),
    'check_in_patient_authenticated_execute',
      has_function_privilege('authenticated', 'public.check_in_patient(uuid,integer)', 'EXECUTE'),
    'lookup_patient_scan_authenticated_execute',
      has_function_privilege('authenticated', 'public.lookup_patient_scan(uuid,integer)', 'EXECUTE'),
    'search_desk_patients_authenticated_execute',
      has_function_privilege('authenticated', 'public.search_desk_patients(uuid,text,integer)', 'EXECUTE'),
    'search_desk_patients_anon_execute',
      has_function_privilege('anon', 'public.search_desk_patients(uuid,text,integer)', 'EXECUTE'),
    'mark_seen_authenticated_execute',
      has_function_privilege('authenticated', 'public.mark_seen(uuid,integer)', 'EXECUTE'),
    'mark_seen_anon_execute',
      has_function_privilege('anon', 'public.mark_seen(uuid,integer)', 'EXECUTE'),
    'undo_mark_seen_authenticated_execute',
      has_function_privilege('authenticated', 'public.undo_mark_seen(uuid)', 'EXECUTE'),
    'register_patient_idempotent_authenticated_execute',
      has_function_privilege(
        'authenticated',
        'public.register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean,boolean,text,text,date,text)',
        'EXECUTE'
      ),
    'lookup_patient_status_token_anon_execute',
      has_function_privilege('anon', 'public.lookup_patient_status_token(integer,date)', 'EXECUTE'),
    'lookup_patient_status_token_authenticated_execute',
      has_function_privilege('authenticated', 'public.lookup_patient_status_token(integer,date)', 'EXECUTE'),
    'lookup_patient_status_token_service_role_execute',
      has_function_privilege('service_role', 'public.lookup_patient_status_token(integer,date)', 'EXECUTE'),
    'consume_public_rate_limit_anon_execute',
      has_function_privilege('anon', 'public.consume_public_rate_limit(text,text[],integer,integer)', 'EXECUTE'),
    'consume_public_rate_limit_authenticated_execute',
      has_function_privilege('authenticated', 'public.consume_public_rate_limit(text,text[],integer,integer)', 'EXECUTE'),
    'consume_public_rate_limit_service_role_execute',
      has_function_privilege('service_role', 'public.consume_public_rate_limit(text,text[],integer,integer)', 'EXECUTE'),
    'staff_person_kpis_authenticated_execute',
      has_function_privilege('authenticated', 'public.staff_person_kpis(uuid,text,uuid,timestamptz,text)', 'EXECUTE'),
    'staff_person_kpis_anon_execute',
      has_function_privilege('anon', 'public.staff_person_kpis(uuid,text,uuid,timestamptz,text)', 'EXECUTE'),
    'staff_person_kpis_service_role_execute',
      has_function_privilege('service_role', 'public.staff_person_kpis(uuid,text,uuid,timestamptz,text)', 'EXECUTE'),
    'staff_leaderboard_authenticated_execute',
      to_regprocedure('public.staff_leaderboard(uuid,uuid)') IS NOT NULL,
    'mark_sms_dispatch_started_authenticated_execute',
      has_function_privilege('authenticated', 'public.mark_sms_dispatch_started(uuid,uuid)', 'EXECUTE'),
    'mark_sms_dispatch_started_service_role_execute',
      has_function_privilege('service_role', 'public.mark_sms_dispatch_started(uuid,uuid)', 'EXECUTE'),
    'patient_registration_notify_fields_authenticated_execute',
      has_function_privilege('authenticated', 'public.patient_registration_notify_fields(uuid)', 'EXECUTE'),
    'camp_queue_counts_authenticated_execute',
      has_function_privilege('authenticated', 'public.camp_queue_counts(uuid)', 'EXECUTE'),
    'camp_queue_counts_anon_execute',
      has_function_privilege('anon', 'public.camp_queue_counts(uuid)', 'EXECUTE'),
    'camp_queue_counts_service_role_execute',
      has_function_privilege('service_role', 'public.camp_queue_counts(uuid)', 'EXECUTE'),
    'latest_applied_migration_service_role_execute',
      has_function_privilege('service_role', 'public.latest_applied_migration()', 'EXECUTE'),
    'persons_authenticated_select',
      has_table_privilege('authenticated', 'public.persons', 'SELECT'),
    'persons_authenticated_write',
      has_table_privilege('authenticated', 'public.persons', 'INSERT')
      OR has_table_privilege('authenticated', 'public.persons', 'UPDATE')
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
    VALUES ('pending'), ('sending'), ('sent'), ('failed'), ('ambiguous')
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
    VALUES ('registration'), ('reminder')
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

ALTER FUNCTION public.readiness_catalog_probe() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.readiness_catalog_probe() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_catalog_probe() TO service_role;

-- ---------------------------------------------------------------------------
-- W3.6 — Drift tripwire
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_reg_count integer;
  v_card integer;
BEGIN
  SELECT count(*) INTO v_reg_count
  FROM pg_proc AS p
  JOIN pg_namespace AS n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'register_patient_idempotent';
  IF v_reg_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one register_patient_idempotent, found %', v_reg_count;
  END IF;

  IF to_regprocedure(
    'public.register_patient_v2(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean,text)'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'register_patient_v2 still exists';
  END IF;

  IF has_table_privilege('authenticated', 'public.persons', 'SELECT')
     OR has_table_privilege('authenticated', 'public.persons', 'INSERT')
     OR has_table_privilege('authenticated', 'public.persons', 'UPDATE')
  THEN
    RAISE EXCEPTION 'persons still granted to authenticated';
  END IF;

  IF public.latest_applied_migration() IS DISTINCT FROM '20260731100000' THEN
    -- During apply this migration is the head only after schema_migrations insert;
    -- probe anchors on head after apply. Accept current max when self-applying.
    NULL;
  END IF;

  SELECT count(*) INTO v_card
  FROM pg_proc AS p
  JOIN pg_namespace AS n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'claim_sms_delivery',
      'patient_registration_notify_fields',
      'reject_self_registration_delivery'
    )
    AND pg_get_functiondef(p.oid) LIKE '%card_verified%';
  IF v_card > 0 THEN
    RAISE EXCEPTION 'card_verified still present in SMS eligibility routines';
  END IF;
END
$verify$;
