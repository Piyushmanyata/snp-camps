ALTER TYPE public.sms_delivery_kind ADD VALUE IF NOT EXISTS 'spectacles_deferral';
ALTER TYPE public.sms_delivery_kind ADD VALUE IF NOT EXISTS 'surgery_deferral';
ALTER TYPE public.sms_delivery_kind ADD VALUE IF NOT EXISTS 'spectacles_deferral_t1';
ALTER TYPE public.sms_delivery_kind ADD VALUE IF NOT EXISTS 'surgery_deferral_t1';

CREATE OR REPLACE FUNCTION public.readiness_catalog_probe_20260813()
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
  v_clinical_signatures text[] := ARRAY[
    'public.is_clinical_operator()',
    'public.clinical_lookup(uuid,integer)',
    'public.clinical_save_transcription(uuid,jsonb)',
    'public.clinical_add_correction(uuid,jsonb,text)',
    'public.clinical_resolve_item(uuid,text,text,text[],uuid)',
    'public.clinical_followup_fulfil(uuid)',
    'public.clinical_followup_lookup(uuid,integer)',
    'public.clinical_slip_by_id(uuid)',
    'public.clinical_replace_slip(uuid,date,text,text)',
    'public.admin_prescription_template_editor(uuid)',
    'public.admin_save_prescription_template(uuid,jsonb,boolean)',
    'public.admin_clinical_records(uuid,boolean,integer,integer)',
    'public.admin_archive_transcription(uuid,boolean)',
    'public.admin_reverse_fulfilment(uuid,text)',
    'public.published_prescription_template(uuid)'
  ];
BEGIN
  SELECT jsonb_object_agg(expected.name, to_regclass('public.' || expected.name) IS NOT NULL)
  INTO v_tables
  FROM (VALUES
    ('patients'), ('persons'), ('camps'), ('camp_days'), ('profiles'),
    ('sms_deliveries'), ('public_rate_limit_buckets'),
    ('prescription_transcriptions'), ('prescription_corrections'),
    ('fulfilment_items'), ('fulfilment_events'), ('deferred_slips'),
    ('prescription_template_versions'), ('sponsor_assets'),
    ('aadhaar_extraction_events')
  ) AS expected(name);

  SELECT jsonb_object_agg(expected.table_name || '.' || expected.column_name,
    EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = expected.table_name
        AND c.column_name = expected.column_name
    ))
  INTO v_columns
  FROM (VALUES
    ('patients','id'), ('patients','status_token'), ('patients','queue_status'),
    ('patients','queued_at'), ('patients','printed_at'), ('patients','seen_at'),
    ('patients','seen_by'), ('patients','reg_no'), ('patients','camp_id'),
    ('patients','camp_day_id'), ('patients','full_name'), ('patients','display_name'),
    ('patients','person_id'), ('patients','provenance'), ('patients','phone_provenance'),
    ('persons','id'), ('persons','reg_no'), ('persons','full_name'),
    ('persons','display_name'), ('persons','gender'), ('persons','date_of_birth'),
    ('persons','aadhaar_last4'), ('persons','duplicate_key'),
    ('persons','aadhaar_locked_at'), ('persons','name_locked_at'),
    ('camps','id'), ('camps','name'), ('camps','is_active'), ('camps','venue'),
    ('camps','prescription_template'), ('camp_days','id'), ('camp_days','camp_id'),
    ('camp_days','day_date'), ('camp_days','seat_limit'), ('profiles','id'),
    ('profiles','role'), ('profiles','disabled_at'), ('profiles','team_lead_id'),
    ('sms_deliveries','id'), ('sms_deliveries','patient_id'), ('sms_deliveries','kind'),
    ('sms_deliveries','state'), ('sms_deliveries','claim_token'),
    ('sms_deliveries','phone_last4'), ('sms_deliveries','attempt_count'),
    ('sms_deliveries','dispatch_started_at'), ('sms_deliveries','updated_at'),
    ('public_rate_limit_buckets','scope'), ('public_rate_limit_buckets','key_hash'),
    ('public_rate_limit_buckets','window_started_at'),
    ('public_rate_limit_buckets','attempts'), ('public_rate_limit_buckets','expires_at'),
    ('prescription_transcriptions','id'), ('prescription_transcriptions','patient_id'),
    ('prescription_transcriptions','data'), ('prescription_transcriptions','paper_source'),
    ('prescription_transcriptions','created_by'), ('prescription_transcriptions','created_at'),
    ('prescription_transcriptions','updated_by'), ('prescription_transcriptions','updated_at'),
    ('prescription_transcriptions','locked_at'), ('prescription_transcriptions','archived_at'),
    ('prescription_corrections','id'), ('prescription_corrections','transcription_id'),
    ('prescription_corrections','reason'), ('prescription_corrections','correction_kind'),
    ('prescription_corrections','replacement_data'), ('prescription_corrections','created_by'),
    ('prescription_corrections','created_at'), ('fulfilment_items','id'),
    ('fulfilment_items','transcription_id'), ('fulfilment_items','kind'),
    ('fulfilment_items','outcome'), ('fulfilment_items','current_version'),
    ('fulfilment_items','resolved_by'), ('fulfilment_items','resolved_at'),
    ('fulfilment_items','unavailable_medicines'),
    ('fulfilment_events','id'), ('fulfilment_events','item_id'), ('fulfilment_events','event'),
    ('fulfilment_events','from_outcome'), ('fulfilment_events','to_outcome'),
    ('fulfilment_events','reason'), ('fulfilment_events','created_by'),
    ('fulfilment_events','created_at'), ('deferred_slips','id'), ('deferred_slips','item_id'),
    ('deferred_slips','reference'), ('deferred_slips','version'), ('deferred_slips','service'),
    ('deferred_slips','date_snapshot'), ('deferred_slips','venue_snapshot'),
    ('deferred_slips','issued_by'), ('deferred_slips','issued_at'), ('deferred_slips','status'),
    ('deferred_slips','replaced_by'), ('prescription_template_versions','id'),
    ('prescription_template_versions','camp_id'), ('prescription_template_versions','version'),
    ('prescription_template_versions','status'), ('prescription_template_versions','template'),
    ('prescription_template_versions','created_by'), ('prescription_template_versions','created_at'),
    ('prescription_template_versions','published_at'), ('sponsor_assets','id'),
    ('sponsor_assets','camp_id'), ('sponsor_assets','object_key'), ('sponsor_assets','mime_type'),
    ('sponsor_assets','byte_size'), ('sponsor_assets','created_by'), ('sponsor_assets','created_at'),
    ('sponsor_assets','state'), ('sponsor_assets','state_changed_at'),
    ('sponsor_assets','cleanup_attempts'), ('sponsor_assets','last_error_code'),
    ('aadhaar_extraction_events','id'), ('aadhaar_extraction_events','patient_id'),
    ('aadhaar_extraction_events','consent_at'), ('aadhaar_extraction_events','method'),
    ('aadhaar_extraction_events','trust_level'), ('aadhaar_extraction_events','outcome'),
    ('aadhaar_extraction_events','aadhaar_last4'), ('aadhaar_extraction_events','created_at')
  ) AS expected(table_name, column_name);

  SELECT jsonb_object_agg(expected.name, to_regprocedure(expected.signature) IS NOT NULL)
  INTO v_functions
  FROM (VALUES
    ('is_clinical_operator','public.is_clinical_operator()'),
    ('assert_valid_clinical_data','public.assert_valid_clinical_data(jsonb)'),
    ('clinical_lookup','public.clinical_lookup(uuid,integer)'),
    ('clinical_save_transcription','public.clinical_save_transcription(uuid,jsonb)'),
    ('clinical_add_correction','public.clinical_add_correction(uuid,jsonb,text)'),
    ('clinical_resolve_item','public.clinical_resolve_item(uuid,text,text,text[],uuid)'),
    ('clinical_followup_fulfil','public.clinical_followup_fulfil(uuid)'),
    ('clinical_followup_lookup','public.clinical_followup_lookup(uuid,integer)'),
    ('clinical_slip_by_id','public.clinical_slip_by_id(uuid)'),
    ('clinical_replace_slip','public.clinical_replace_slip(uuid,date,text,text)'),
    ('admin_prescription_template_editor','public.admin_prescription_template_editor(uuid)'),
    ('admin_save_prescription_template','public.admin_save_prescription_template(uuid,jsonb,boolean)'),
    ('admin_clinical_records','public.admin_clinical_records(uuid,boolean,integer,integer)'),
    ('admin_archive_transcription','public.admin_archive_transcription(uuid,boolean)'),
    ('admin_reverse_fulfilment','public.admin_reverse_fulfilment(uuid,text)'),
    ('published_prescription_template','public.published_prescription_template(uuid)'),
    ('audit_scanned_aadhaar_registration','public.audit_scanned_aadhaar_registration()'),
    ('latest_applied_migration','public.latest_applied_migration()'),
    ('readiness_catalog_probe','public.readiness_catalog_probe()'),
    ('patient_status_by_token','public.patient_status_by_token(text)'),
    ('upsert_camp_day','public.upsert_camp_day(uuid,date,integer,uuid)'),
    ('register_patient_idempotent','public.register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean,boolean,text,text,date,text)'),
    ('mark_patient_printed','public.mark_patient_printed(uuid,integer)'),
    ('lookup_patient_scan','public.lookup_patient_scan(uuid,integer)'),
    ('mark_seen','public.mark_seen(uuid,integer)'),
    ('undo_mark_seen','public.undo_mark_seen(uuid)'),
    ('lookup_patient_status_token','public.lookup_patient_status_token(integer,date)'),
    ('consume_public_rate_limit','public.consume_public_rate_limit(text,text[],integer,integer)'),
    ('active_registration_id','public.active_registration_id(uuid,integer)'),
    ('staff_person_kpis','public.staff_person_kpis(uuid,text,uuid,text)'),
    ('claim_sms_delivery','public.claim_sms_delivery(uuid,public.sms_delivery_kind,text,integer)'),
    ('mark_sms_dispatch_started','public.mark_sms_dispatch_started(uuid,uuid)'),
    ('complete_sms_delivery','public.complete_sms_delivery(uuid,uuid,text,text,text)'),
    ('patient_registration_notify_fields','public.patient_registration_notify_fields(uuid)'),
    ('camp_queue_counts','public.camp_queue_counts(uuid)'),
    ('search_desk_patients','public.search_desk_patients(uuid,text,integer)'),
    ('print_patient','public.print_patient(uuid)'),
    ('staff_registered_patients','public.staff_registered_patients(uuid,integer)'),
    ('begin_sponsor_asset_deletion','public.begin_sponsor_asset_deletion(uuid)'),
    ('finish_sponsor_asset_deletion','public.finish_sponsor_asset_deletion(uuid)'),
    ('admin_clinical_export','public.admin_clinical_export(uuid,text,boolean)')
  ) AS expected(name, signature);

  v_invariants := jsonb_build_object(
    'patients_camp_reg_no_unique', EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.patients'::regclass
        AND conname='patients_camp_reg_no_key' AND contype='u' AND convalidated
    ),
    'patients_person_camp_unique', EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.patients'::regclass
        AND conname='patients_person_camp_key' AND contype='u' AND convalidated
    ),
    'patients_person_id_not_null', EXISTS (
      SELECT 1 FROM pg_attribute WHERE attrelid='public.patients'::regclass
        AND attname='person_id' AND attnotnull AND NOT attisdropped
    ),
    'patients_provenance_current', EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.patients'::regclass
        AND conname='patients_provenance_check' AND convalidated
        AND pg_get_constraintdef(oid) LIKE '%self_declared%'
        AND pg_get_constraintdef(oid) LIKE '%card_scanned%'
        AND pg_get_constraintdef(oid) NOT LIKE '%ekyc_verified%'
    ),
    'retired_ekyc_storage_absent', NOT EXISTS (
      SELECT 1 FROM information_schema.columns WHERE table_schema='public'
        AND table_name='patients' AND column_name IN ('aadhaar_hash','aadhaar_verified_at','aadhaar_kyc_ref')
    ),
    'register_rpc_supported_signatures_only', (
      SELECT count(*)=1 AND bool_and(
        pg_get_function_arguments(p.oid) NOT ILIKE '%aadhaar_hash%'
        AND pg_get_function_arguments(p.oid) NOT ILIKE '%aadhaar_verified_at%'
        AND pg_get_function_arguments(p.oid) NOT ILIKE '%aadhaar_kyc_ref%'
      ) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='register_patient_idempotent'
    ) AND to_regprocedure('public.register_patient_v2(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean,text)') IS NULL,
    'patients_phone_provenance_current', EXISTS (
      SELECT 1 FROM information_schema.columns WHERE table_schema='public'
        AND table_name='patients' AND column_name='phone_provenance'
        AND is_nullable='NO' AND column_default LIKE '%self_declared%'
    ) AND EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.patients'::regclass
        AND conname='patients_phone_provenance_check' AND contype='c' AND convalidated
    ),
    'staff_kpi_single_contract', (
      SELECT count(*)=1 AND bool_and(p.oid=to_regprocedure('public.staff_person_kpis(uuid,text,uuid,text)'))
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='staff_person_kpis'
    ),
    'staff_leaderboard_absent', to_regprocedure('public.staff_leaderboard(uuid,uuid)') IS NULL,
    'migration_head_current', public.latest_applied_migration() = (
      SELECT max(version) FROM supabase_migrations.schema_migrations
    ),
    'profiles_team_lead_fk', EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.profiles'::regclass
        AND conname='profiles_team_lead_id_fkey' AND contype='f' AND convalidated
    ),
    'team_membership_guards', (
      SELECT count(*)=2 AND bool_and(tgenabled <> 'D') FROM pg_trigger
      WHERE tgrelid='public.profiles'::regclass AND NOT tgisinternal
        AND tgname IN ('validate_profile_team_membership','release_disabled_team_members')
    ),
    'prescription_records_absent', to_regclass('public.prescriptions') IS NULL
      AND to_regclass('public.treatment_orders') IS NULL
      AND to_regclass('public.prescription_amendments') IS NULL,
    'doctor_station_retired', to_regprocedure('public.assign_patient_doctor(uuid,integer,uuid)') IS NULL
      AND to_regprocedure('public.is_doctor()') IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.profiles WHERE role='doctor'::public.user_role AND disabled_at IS NULL),
    'mark_seen_contract', to_regprocedure('public.mark_seen(uuid,integer)') IS NOT NULL
      AND to_regprocedure('public.undo_mark_seen(uuid)') IS NOT NULL,
    'public_rate_limit_primary_key', EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.public_rate_limit_buckets'::regclass
        AND conname='public_rate_limit_buckets_pkey' AND contype='p' AND convalidated
    ),
    'transcription_patient_unique', EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.prescription_transcriptions'::regclass
        AND contype='u' AND pg_get_constraintdef(oid) LIKE '%(patient_id)%' AND convalidated
    ),
    'fulfilment_kind_unique', EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.fulfilment_items'::regclass
        AND contype='u' AND pg_get_constraintdef(oid) LIKE '%(transcription_id, kind)%' AND convalidated
    ),
    'deferred_one_active', to_regclass('public.deferred_slips_one_active') IS NOT NULL,
    'template_one_published', to_regclass('public.prescription_template_one_published') IS NOT NULL,
    'template_one_draft', to_regclass('public.prescription_template_one_draft') IS NOT NULL,
    'sponsor_object_key_unique', EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.sponsor_assets'::regclass
        AND contype='u' AND pg_get_constraintdef(oid) LIKE '%(object_key)%' AND convalidated
    ),
    'sponsor_state_check', EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.sponsor_assets'::regclass
        AND conname='sponsor_assets_state_check' AND convalidated
        AND pg_get_constraintdef(oid) LIKE '%pending%'
        AND pg_get_constraintdef(oid) LIKE '%ready%'
        AND pg_get_constraintdef(oid) LIKE '%deleting%'
    ),
    'aadhaar_event_patient_unique', EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.aadhaar_extraction_events'::regclass
        AND contype='u' AND pg_get_constraintdef(oid) LIKE '%(patient_id)%' AND convalidated
    ),
    'clinical_rls_enabled', (
      SELECT bool_and(relrowsecurity) FROM pg_class
      WHERE oid IN ('public.prescription_transcriptions'::regclass,
        'public.prescription_corrections'::regclass,'public.fulfilment_items'::regclass,
        'public.fulfilment_events'::regclass,'public.deferred_slips'::regclass,
        'public.prescription_template_versions'::regclass,'public.sponsor_assets'::regclass,
        'public.aadhaar_extraction_events'::regclass)
    ),
    'sponsor_bucket_private', EXISTS (
      SELECT 1 FROM storage.buckets WHERE id='prescription-sponsors' AND public=false
    ),
    'sponsor_bucket_restrictions', EXISTS (
      SELECT 1 FROM storage.buckets
      WHERE id='prescription-sponsors' AND file_size_limit=2097152
        AND cardinality(allowed_mime_types)=3
        AND allowed_mime_types @> ARRAY['image/png','image/jpeg','image/webp']::text[]
    )
  );

  v_grants := jsonb_build_object(
    'patients_status_token_authenticated_select', has_column_privilege('authenticated','public.patients','status_token','SELECT'),
    'patient_status_by_token_authenticated_execute', CASE WHEN to_regprocedure('public.patient_status_by_token(text)') IS NOT NULL THEN has_function_privilege('authenticated','public.patient_status_by_token(text)','EXECUTE') ELSE false END,
    'patient_status_by_token_anon_execute', CASE WHEN to_regprocedure('public.patient_status_by_token(text)') IS NOT NULL THEN has_function_privilege('anon','public.patient_status_by_token(text)','EXECUTE') ELSE false END,
    'patient_status_by_token_service_role_execute', CASE WHEN to_regprocedure('public.patient_status_by_token(text)') IS NOT NULL THEN has_function_privilege('service_role','public.patient_status_by_token(text)','EXECUTE') ELSE false END,
    'sms_deliveries_authenticated_select', has_table_privilege('authenticated','public.sms_deliveries','SELECT'),
    'claim_sms_delivery_service_role_execute', CASE WHEN to_regprocedure('public.claim_sms_delivery(uuid,public.sms_delivery_kind,text,integer)') IS NOT NULL THEN has_function_privilege('service_role','public.claim_sms_delivery(uuid,public.sms_delivery_kind,text,integer)','EXECUTE') ELSE false END,
    'complete_sms_delivery_service_role_execute', CASE WHEN to_regprocedure('public.complete_sms_delivery(uuid,uuid,text,text,text)') IS NOT NULL THEN has_function_privilege('service_role','public.complete_sms_delivery(uuid,uuid,text,text,text)','EXECUTE') ELSE false END,
    'upsert_camp_day_authenticated_execute', CASE WHEN to_regprocedure('public.upsert_camp_day(uuid,date,integer,uuid)') IS NOT NULL THEN has_function_privilege('authenticated','public.upsert_camp_day(uuid,date,integer,uuid)','EXECUTE') ELSE false END,
    'mark_patient_printed_authenticated_execute', CASE WHEN to_regprocedure('public.mark_patient_printed(uuid,integer)') IS NOT NULL THEN has_function_privilege('authenticated','public.mark_patient_printed(uuid,integer)','EXECUTE') ELSE false END,
    'lookup_patient_scan_authenticated_execute', CASE WHEN to_regprocedure('public.lookup_patient_scan(uuid,integer)') IS NOT NULL THEN has_function_privilege('authenticated','public.lookup_patient_scan(uuid,integer)','EXECUTE') ELSE false END,
    'search_desk_patients_authenticated_execute', CASE WHEN to_regprocedure('public.search_desk_patients(uuid,text,integer)') IS NOT NULL THEN has_function_privilege('authenticated','public.search_desk_patients(uuid,text,integer)','EXECUTE') ELSE false END,
    'search_desk_patients_anon_execute', CASE WHEN to_regprocedure('public.search_desk_patients(uuid,text,integer)') IS NOT NULL THEN has_function_privilege('anon','public.search_desk_patients(uuid,text,integer)','EXECUTE') ELSE false END,
    'mark_seen_authenticated_execute', CASE WHEN to_regprocedure('public.mark_seen(uuid,integer)') IS NOT NULL THEN has_function_privilege('authenticated','public.mark_seen(uuid,integer)','EXECUTE') ELSE false END,
    'mark_seen_anon_execute', CASE WHEN to_regprocedure('public.mark_seen(uuid,integer)') IS NOT NULL THEN has_function_privilege('anon','public.mark_seen(uuid,integer)','EXECUTE') ELSE false END,
    'undo_mark_seen_authenticated_execute', CASE WHEN to_regprocedure('public.undo_mark_seen(uuid)') IS NOT NULL THEN has_function_privilege('authenticated','public.undo_mark_seen(uuid)','EXECUTE') ELSE false END,
    'register_patient_idempotent_authenticated_execute', CASE WHEN to_regprocedure('public.register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean,boolean,text,text,date,text)') IS NOT NULL THEN has_function_privilege('authenticated','public.register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean,boolean,text,text,date,text)','EXECUTE') ELSE false END,
    'lookup_patient_status_token_anon_execute', CASE WHEN to_regprocedure('public.lookup_patient_status_token(integer,date)') IS NOT NULL THEN has_function_privilege('anon','public.lookup_patient_status_token(integer,date)','EXECUTE') ELSE false END,
    'lookup_patient_status_token_authenticated_execute', CASE WHEN to_regprocedure('public.lookup_patient_status_token(integer,date)') IS NOT NULL THEN has_function_privilege('authenticated','public.lookup_patient_status_token(integer,date)','EXECUTE') ELSE false END,
    'lookup_patient_status_token_service_role_execute', CASE WHEN to_regprocedure('public.lookup_patient_status_token(integer,date)') IS NOT NULL THEN has_function_privilege('service_role','public.lookup_patient_status_token(integer,date)','EXECUTE') ELSE false END,
    'consume_public_rate_limit_anon_execute', CASE WHEN to_regprocedure('public.consume_public_rate_limit(text,text[],integer,integer)') IS NOT NULL THEN has_function_privilege('anon','public.consume_public_rate_limit(text,text[],integer,integer)','EXECUTE') ELSE false END
  ) || jsonb_build_object(
    'consume_public_rate_limit_authenticated_execute', CASE WHEN to_regprocedure('public.consume_public_rate_limit(text,text[],integer,integer)') IS NOT NULL THEN has_function_privilege('authenticated','public.consume_public_rate_limit(text,text[],integer,integer)','EXECUTE') ELSE false END,
    'consume_public_rate_limit_service_role_execute', CASE WHEN to_regprocedure('public.consume_public_rate_limit(text,text[],integer,integer)') IS NOT NULL THEN has_function_privilege('service_role','public.consume_public_rate_limit(text,text[],integer,integer)','EXECUTE') ELSE false END,
    'staff_person_kpis_authenticated_execute', CASE WHEN to_regprocedure('public.staff_person_kpis(uuid,text,uuid,text)') IS NOT NULL THEN has_function_privilege('authenticated','public.staff_person_kpis(uuid,text,uuid,text)','EXECUTE') ELSE false END,
    'staff_person_kpis_anon_execute', CASE WHEN to_regprocedure('public.staff_person_kpis(uuid,text,uuid,text)') IS NOT NULL THEN has_function_privilege('anon','public.staff_person_kpis(uuid,text,uuid,text)','EXECUTE') ELSE false END,
    'staff_person_kpis_service_role_execute', CASE WHEN to_regprocedure('public.staff_person_kpis(uuid,text,uuid,text)') IS NOT NULL THEN has_function_privilege('service_role','public.staff_person_kpis(uuid,text,uuid,text)','EXECUTE') ELSE false END,
    'staff_leaderboard_authenticated_execute', to_regprocedure('public.staff_leaderboard(uuid,uuid)') IS NOT NULL,
    'mark_sms_dispatch_started_authenticated_execute', CASE WHEN to_regprocedure('public.mark_sms_dispatch_started(uuid,uuid)') IS NOT NULL THEN has_function_privilege('authenticated','public.mark_sms_dispatch_started(uuid,uuid)','EXECUTE') ELSE false END,
    'mark_sms_dispatch_started_service_role_execute', CASE WHEN to_regprocedure('public.mark_sms_dispatch_started(uuid,uuid)') IS NOT NULL THEN has_function_privilege('service_role','public.mark_sms_dispatch_started(uuid,uuid)','EXECUTE') ELSE false END,
    'patient_registration_notify_fields_authenticated_execute', CASE WHEN to_regprocedure('public.patient_registration_notify_fields(uuid)') IS NOT NULL THEN has_function_privilege('authenticated','public.patient_registration_notify_fields(uuid)','EXECUTE') ELSE false END,
    'camp_queue_counts_authenticated_execute', CASE WHEN to_regprocedure('public.camp_queue_counts(uuid)') IS NOT NULL THEN has_function_privilege('authenticated','public.camp_queue_counts(uuid)','EXECUTE') ELSE false END,
    'camp_queue_counts_anon_execute', CASE WHEN to_regprocedure('public.camp_queue_counts(uuid)') IS NOT NULL THEN has_function_privilege('anon','public.camp_queue_counts(uuid)','EXECUTE') ELSE false END,
    'camp_queue_counts_service_role_execute', CASE WHEN to_regprocedure('public.camp_queue_counts(uuid)') IS NOT NULL THEN has_function_privilege('service_role','public.camp_queue_counts(uuid)','EXECUTE') ELSE false END,
    'latest_applied_migration_service_role_execute', CASE WHEN to_regprocedure('public.latest_applied_migration()') IS NOT NULL THEN has_function_privilege('service_role','public.latest_applied_migration()','EXECUTE') ELSE false END,
    'persons_authenticated_select', has_table_privilege('authenticated','public.persons','SELECT'),
    'persons_authenticated_write', has_table_privilege('authenticated','public.persons','INSERT') OR has_table_privilege('authenticated','public.persons','UPDATE'),
    'patients_authenticated_select', has_table_privilege('authenticated','public.patients','SELECT'),
    'prescription_transcriptions_authenticated_write', has_table_privilege('authenticated','public.prescription_transcriptions','INSERT') OR has_table_privilege('authenticated','public.prescription_transcriptions','UPDATE') OR has_table_privilege('authenticated','public.prescription_transcriptions','DELETE'),
    'prescription_corrections_authenticated_write', has_table_privilege('authenticated','public.prescription_corrections','INSERT') OR has_table_privilege('authenticated','public.prescription_corrections','UPDATE') OR has_table_privilege('authenticated','public.prescription_corrections','DELETE'),
    'fulfilment_items_authenticated_write', has_table_privilege('authenticated','public.fulfilment_items','INSERT') OR has_table_privilege('authenticated','public.fulfilment_items','UPDATE') OR has_table_privilege('authenticated','public.fulfilment_items','DELETE'),
    'fulfilment_events_authenticated_write', has_table_privilege('authenticated','public.fulfilment_events','INSERT') OR has_table_privilege('authenticated','public.fulfilment_events','UPDATE') OR has_table_privilege('authenticated','public.fulfilment_events','DELETE')
  ) || jsonb_build_object(
    'deferred_slips_authenticated_write', has_table_privilege('authenticated','public.deferred_slips','INSERT') OR has_table_privilege('authenticated','public.deferred_slips','UPDATE') OR has_table_privilege('authenticated','public.deferred_slips','DELETE'),
    'prescription_template_versions_authenticated_write', has_table_privilege('authenticated','public.prescription_template_versions','INSERT') OR has_table_privilege('authenticated','public.prescription_template_versions','UPDATE') OR has_table_privilege('authenticated','public.prescription_template_versions','DELETE'),
    'sponsor_assets_authenticated_write', has_table_privilege('authenticated','public.sponsor_assets','INSERT') OR has_table_privilege('authenticated','public.sponsor_assets','UPDATE') OR has_table_privilege('authenticated','public.sponsor_assets','DELETE'),
    'aadhaar_extraction_events_authenticated_write', has_table_privilege('authenticated','public.aadhaar_extraction_events','INSERT') OR has_table_privilege('authenticated','public.aadhaar_extraction_events','UPDATE') OR has_table_privilege('authenticated','public.aadhaar_extraction_events','DELETE'),
    'aadhaar_extraction_events_authenticated_access', has_table_privilege('authenticated','public.aadhaar_extraction_events','SELECT') OR has_table_privilege('authenticated','public.aadhaar_extraction_events','INSERT') OR has_table_privilege('authenticated','public.aadhaar_extraction_events','UPDATE') OR has_table_privilege('authenticated','public.aadhaar_extraction_events','DELETE'),
    'prescription_transcriptions_anon_access', has_table_privilege('anon','public.prescription_transcriptions','SELECT') OR has_table_privilege('anon','public.prescription_transcriptions','INSERT') OR has_table_privilege('anon','public.prescription_transcriptions','UPDATE') OR has_table_privilege('anon','public.prescription_transcriptions','DELETE'),
    'prescription_corrections_anon_access', has_table_privilege('anon','public.prescription_corrections','SELECT') OR has_table_privilege('anon','public.prescription_corrections','INSERT') OR has_table_privilege('anon','public.prescription_corrections','UPDATE') OR has_table_privilege('anon','public.prescription_corrections','DELETE'),
    'fulfilment_items_anon_access', has_table_privilege('anon','public.fulfilment_items','SELECT') OR has_table_privilege('anon','public.fulfilment_items','INSERT') OR has_table_privilege('anon','public.fulfilment_items','UPDATE') OR has_table_privilege('anon','public.fulfilment_items','DELETE'),
    'fulfilment_events_anon_access', has_table_privilege('anon','public.fulfilment_events','SELECT') OR has_table_privilege('anon','public.fulfilment_events','INSERT') OR has_table_privilege('anon','public.fulfilment_events','UPDATE') OR has_table_privilege('anon','public.fulfilment_events','DELETE'),
    'deferred_slips_anon_access', has_table_privilege('anon','public.deferred_slips','SELECT') OR has_table_privilege('anon','public.deferred_slips','INSERT') OR has_table_privilege('anon','public.deferred_slips','UPDATE') OR has_table_privilege('anon','public.deferred_slips','DELETE'),
    'prescription_template_versions_anon_access', has_table_privilege('anon','public.prescription_template_versions','SELECT') OR has_table_privilege('anon','public.prescription_template_versions','INSERT') OR has_table_privilege('anon','public.prescription_template_versions','UPDATE') OR has_table_privilege('anon','public.prescription_template_versions','DELETE'),
    'sponsor_assets_anon_access', has_table_privilege('anon','public.sponsor_assets','SELECT') OR has_table_privilege('anon','public.sponsor_assets','INSERT') OR has_table_privilege('anon','public.sponsor_assets','UPDATE') OR has_table_privilege('anon','public.sponsor_assets','DELETE'),
    'aadhaar_extraction_events_anon_access', has_table_privilege('anon','public.aadhaar_extraction_events','SELECT') OR has_table_privilege('anon','public.aadhaar_extraction_events','INSERT') OR has_table_privilege('anon','public.aadhaar_extraction_events','UPDATE') OR has_table_privilege('anon','public.aadhaar_extraction_events','DELETE'),
    'clinical_callable_authenticated_execute', (SELECT coalesce(bool_and(has_function_privilege('authenticated', sig, 'EXECUTE')), true) FROM unnest(v_clinical_signatures) sig),
    'clinical_callable_service_role_execute', (SELECT coalesce(bool_and(has_function_privilege('service_role', sig, 'EXECUTE')), true) FROM unnest(v_clinical_signatures) sig),
    'clinical_internal_anon_execute', (SELECT coalesce(bool_or(has_function_privilege('anon', sig, 'EXECUTE')), false) FROM unnest(v_clinical_signatures) sig),
    'clinical_callable_public_execute', (SELECT coalesce(bool_or(has_function_privilege('anon', sig, 'EXECUTE')), false) FROM unnest(v_clinical_signatures) sig),
    'assert_valid_clinical_data_authenticated_execute', has_function_privilege('authenticated','public.assert_valid_clinical_data(jsonb)','EXECUTE'),
    'assert_valid_clinical_data_anon_execute', has_function_privilege('anon','public.assert_valid_clinical_data(jsonb)','EXECUTE'),
    'assert_valid_clinical_data_service_role_execute', has_function_privilege('service_role','public.assert_valid_clinical_data(jsonb)','EXECUTE'),
    'audit_scanned_aadhaar_authenticated_execute', CASE WHEN to_regprocedure('public.audit_scanned_aadhaar_registration()') IS NOT NULL THEN has_function_privilege('authenticated','public.audit_scanned_aadhaar_registration()','EXECUTE') ELSE false END,
    'audit_scanned_aadhaar_anon_execute', CASE WHEN to_regprocedure('public.audit_scanned_aadhaar_registration()') IS NOT NULL THEN has_function_privilege('anon','public.audit_scanned_aadhaar_registration()','EXECUTE') ELSE false END,
    'audit_scanned_aadhaar_service_role_execute', CASE WHEN to_regprocedure('public.audit_scanned_aadhaar_registration()') IS NOT NULL THEN has_function_privilege('service_role','public.audit_scanned_aadhaar_registration()','EXECUTE') ELSE false END,
    'print_patient_authenticated_execute', CASE WHEN to_regprocedure('public.print_patient(uuid)') IS NOT NULL THEN has_function_privilege('authenticated','public.print_patient(uuid)','EXECUTE') ELSE false END,
    'staff_registered_patients_authenticated_execute', CASE WHEN to_regprocedure('public.staff_registered_patients(uuid,integer)') IS NOT NULL THEN has_function_privilege('authenticated','public.staff_registered_patients(uuid,integer)','EXECUTE') ELSE false END,
    'begin_sponsor_asset_deletion_authenticated_execute', CASE WHEN to_regprocedure('public.begin_sponsor_asset_deletion(uuid)') IS NOT NULL THEN has_function_privilege('authenticated','public.begin_sponsor_asset_deletion(uuid)','EXECUTE') ELSE false END,
    'finish_sponsor_asset_deletion_authenticated_execute', CASE WHEN to_regprocedure('public.finish_sponsor_asset_deletion(uuid)') IS NOT NULL THEN has_function_privilege('authenticated','public.finish_sponsor_asset_deletion(uuid)','EXECUTE') ELSE false END
  );

  SELECT jsonb_object_agg(expected.name, EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
    JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' AND t.typname='sms_delivery_state' AND e.enumlabel=expected.name
  )) INTO v_states
  FROM (VALUES ('pending'),('sending'),('sent'),('failed'),('ambiguous')) expected(name);

  SELECT jsonb_object_agg(expected.name, EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
    JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' AND t.typname='sms_delivery_kind' AND e.enumlabel=expected.name
  )) INTO v_kinds
  FROM (VALUES ('registration'),('reminder')) expected(name);

  RETURN jsonb_build_object(
    'tables', v_tables,
    'columns', v_columns,
    'functions', v_functions,
    'invariants', v_invariants,
    'grants', v_grants,
    'publication', jsonb_build_object('patients_in_supabase_realtime', EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='patients'
    )),
    'sms', jsonb_build_object(
      'table', to_regclass('public.sms_deliveries') IS NOT NULL,
      'states', v_states,
      'kinds', v_kinds,
      'claim_fn', to_regprocedure('public.claim_sms_delivery(uuid,public.sms_delivery_kind,text,integer)') IS NOT NULL,
      'dispatch_fn', to_regprocedure('public.mark_sms_dispatch_started(uuid,uuid)') IS NOT NULL,
      'complete_fn', to_regprocedure('public.complete_sms_delivery(uuid,uuid,text,text,text)') IS NOT NULL
    )
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.upsert_ot_schedule_day(
  p_camp_id uuid,
  p_day_date date,
  p_venue text,
  p_seat_limit integer,
  p_day_id uuid DEFAULT NULL
)
RETURNS public.ot_schedule_days
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  r public.ot_schedule_days;
  v_taken integer;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only';
  END IF;
  IF p_seat_limit IS NULL OR p_seat_limit < 0 THEN
    RAISE EXCEPTION 'seat_limit must be >= 0';
  END IF;
  IF nullif(btrim(p_venue), '') IS NULL THEN
    RAISE EXCEPTION 'venue required';
  END IF;

  IF p_day_id IS NOT NULL THEN
    SELECT * INTO r FROM public.ot_schedule_days d
    WHERE d.id = p_day_id AND d.camp_id = p_camp_id
    FOR UPDATE;
    IF r.id IS NULL THEN
      RAISE EXCEPTION 'Day not found';
    END IF;
    SELECT count(*)::integer INTO v_taken
    FROM public.fulfilment_items i
    WHERE i.ot_schedule_day_id = p_day_id AND i.outcome = 'deferred';
    IF p_seat_limit < v_taken THEN
      RAISE EXCEPTION 'SEAT_LIMIT_BELOW_ASSIGNED:taken=%', v_taken;
    END IF;
    UPDATE public.ot_schedule_days
    SET day_date = p_day_date, venue = btrim(p_venue), seat_limit = p_seat_limit
    WHERE id = p_day_id
    RETURNING * INTO r;
    RETURN r;
  END IF;

  SELECT * INTO r
  FROM public.ot_schedule_days d
  WHERE d.camp_id = p_camp_id
    AND d.day_date = p_day_date
  FOR UPDATE;

  IF r.id IS NOT NULL THEN
    SELECT count(*)::integer INTO v_taken
    FROM public.fulfilment_items i
    WHERE i.ot_schedule_day_id = r.id AND i.outcome = 'deferred';
    IF p_seat_limit < v_taken THEN
      RAISE EXCEPTION 'SEAT_LIMIT_BELOW_ASSIGNED:taken=%', v_taken;
    END IF;
    UPDATE public.ot_schedule_days
    SET venue = btrim(p_venue), seat_limit = p_seat_limit
    WHERE id = r.id
    RETURNING * INTO r;
    RETURN r;
  END IF;

  BEGIN
    INSERT INTO public.ot_schedule_days (camp_id, day_date, venue, seat_limit)
    VALUES (p_camp_id, p_day_date, btrim(p_venue), p_seat_limit)
    RETURNING * INTO r;
    RETURN r;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT * INTO r
      FROM public.ot_schedule_days d
      WHERE d.camp_id = p_camp_id
        AND d.day_date = p_day_date
      FOR UPDATE;
      IF r.id IS NULL THEN
        RAISE;
      END IF;
      SELECT count(*)::integer INTO v_taken
      FROM public.fulfilment_items i
      WHERE i.ot_schedule_day_id = r.id AND i.outcome = 'deferred';
      IF p_seat_limit < v_taken THEN
        RAISE EXCEPTION 'SEAT_LIMIT_BELOW_ASSIGNED:taken=%', v_taken;
      END IF;
      UPDATE public.ot_schedule_days
      SET venue = btrim(p_venue), seat_limit = p_seat_limit
      WHERE id = r.id
      RETURNING * INTO r;
      RETURN r;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_ot_schedule_day(uuid, date, text, integer, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_ot_schedule_day(uuid, date, text, integer, uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.list_ot_schedule_days(p_camp_id uuid)
RETURNS TABLE (
  id uuid,
  camp_id uuid,
  day_date date,
  venue text,
  seat_limit integer,
  seats_taken integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF NOT (public.is_admin() OR public.is_clinical_operator()) THEN
    RAISE EXCEPTION 'staff only';
  END IF;
  RETURN QUERY
  SELECT
    d.id,
    d.camp_id,
    d.day_date,
    d.venue,
    d.seat_limit,
    (
      SELECT count(*)::integer
      FROM public.fulfilment_items i
      WHERE i.ot_schedule_day_id = d.id AND i.outcome = 'deferred'
    )
  FROM public.ot_schedule_days d
  WHERE d.camp_id = p_camp_id
  ORDER BY d.day_date, d.id;
END;
$$;

REVOKE ALL ON FUNCTION public.list_ot_schedule_days(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_ot_schedule_days(uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.readiness_catalog_probe()
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
  v := jsonb_set(v, '{functions}', (coalesce(v->'functions', '{}'::jsonb) - 'patient_status_by_token' - 'lookup_patient_status_token') || jsonb_build_object(
    'set_camp_day_printing_open',
    to_regprocedure('public.set_camp_day_printing_open(uuid,boolean)') IS NOT NULL,
    'confirm_manual_exception_aadhaar',
    to_regprocedure('public.confirm_manual_exception_aadhaar(uuid,text,text,text,date,text,text,text,boolean,uuid,text)') IS NOT NULL,
    'upsert_ot_schedule_day',
    to_regprocedure('public.upsert_ot_schedule_day(uuid,date,text,integer,uuid)') IS NOT NULL,
    'list_ot_schedule_days',
    to_regprocedure('public.list_ot_schedule_days(uuid)') IS NOT NULL
  ));
  v := jsonb_set(v, '{tables}', coalesce(v->'tables', '{}'::jsonb) || jsonb_build_object(
    'ot_schedule_days',
    to_regclass('public.ot_schedule_days') IS NOT NULL
  ));
  v := jsonb_set(v, '{columns}', (coalesce(v->'columns', '{}'::jsonb) - 'patients.status_token') || jsonb_build_object(
    'camp_days.printing_open',
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'camp_days' AND column_name = 'printing_open'
    ),
    'persons.address_locked_at',
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'persons' AND column_name = 'address_locked_at'
    ),
    'persons.merged_into',
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'persons' AND column_name = 'merged_into'
    ),
    'patients.confirmation_override_actor',
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'patients' AND column_name = 'confirmation_override_actor'
    ),
    'fulfilment_items.ot_schedule_day_id',
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'fulfilment_items' AND column_name = 'ot_schedule_day_id'
    ),
    'ot_schedule_days.id',
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ot_schedule_days' AND column_name = 'id'
    ),
    'ot_schedule_days.camp_id',
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ot_schedule_days' AND column_name = 'camp_id'
    ),
    'ot_schedule_days.day_date',
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ot_schedule_days' AND column_name = 'day_date'
    ),
    'ot_schedule_days.venue',
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ot_schedule_days' AND column_name = 'venue'
    ),
    'ot_schedule_days.seat_limit',
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ot_schedule_days' AND column_name = 'seat_limit'
    )
  ));
  v := jsonb_set(
    v,
    '{grants}',
    coalesce(v->'grants', '{}'::jsonb) || jsonb_build_object(
      'set_camp_day_printing_open_authenticated_execute',
      CASE WHEN to_regprocedure('public.set_camp_day_printing_open(uuid,boolean)') IS NOT NULL
        THEN has_function_privilege('authenticated','public.set_camp_day_printing_open(uuid,boolean)','EXECUTE')
        ELSE false END,
      'set_camp_day_printing_open_anon_execute',
      CASE WHEN to_regprocedure('public.set_camp_day_printing_open(uuid,boolean)') IS NOT NULL
        THEN has_function_privilege('anon','public.set_camp_day_printing_open(uuid,boolean)','EXECUTE')
        ELSE false END,
      'confirm_manual_exception_aadhaar_authenticated_execute',
      CASE WHEN to_regprocedure('public.confirm_manual_exception_aadhaar(uuid,text,text,text,date,text,text,text,boolean,uuid,text)') IS NOT NULL
        THEN has_function_privilege('authenticated','public.confirm_manual_exception_aadhaar(uuid,text,text,text,date,text,text,text,boolean,uuid,text)','EXECUTE')
        ELSE false END,
      'confirm_manual_exception_aadhaar_anon_execute',
      CASE WHEN to_regprocedure('public.confirm_manual_exception_aadhaar(uuid,text,text,text,date,text,text,text,boolean,uuid,text)') IS NOT NULL
        THEN has_function_privilege('anon','public.confirm_manual_exception_aadhaar(uuid,text,text,text,date,text,text,text,boolean,uuid,text)','EXECUTE')
        ELSE false END,
      'confirm_manual_exception_aadhaar_service_role_execute',
      CASE WHEN to_regprocedure('public.confirm_manual_exception_aadhaar(uuid,text,text,text,date,text,text,text,boolean,uuid,text)') IS NOT NULL
        THEN has_function_privilege('service_role','public.confirm_manual_exception_aadhaar(uuid,text,text,text,date,text,text,text,boolean,uuid,text)','EXECUTE')
        ELSE false END,
      'upsert_ot_schedule_day_authenticated_execute',
      CASE WHEN to_regprocedure('public.upsert_ot_schedule_day(uuid,date,text,integer,uuid)') IS NOT NULL
        THEN has_function_privilege('authenticated','public.upsert_ot_schedule_day(uuid,date,text,integer,uuid)','EXECUTE')
        ELSE false END,
      'upsert_ot_schedule_day_anon_execute',
      CASE WHEN to_regprocedure('public.upsert_ot_schedule_day(uuid,date,text,integer,uuid)') IS NOT NULL
        THEN has_function_privilege('anon','public.upsert_ot_schedule_day(uuid,date,text,integer,uuid)','EXECUTE')
        ELSE false END,
      'list_ot_schedule_days_authenticated_execute',
      CASE WHEN to_regprocedure('public.list_ot_schedule_days(uuid)') IS NOT NULL
        THEN has_function_privilege('authenticated','public.list_ot_schedule_days(uuid)','EXECUTE')
        ELSE false END,
      'list_ot_schedule_days_anon_execute',
      CASE WHEN to_regprocedure('public.list_ot_schedule_days(uuid)') IS NOT NULL
        THEN has_function_privilege('anon','public.list_ot_schedule_days(uuid)','EXECUTE')
        ELSE false END
    )
  );
  v := jsonb_set(
    v,
    '{sms,kinds}',
    coalesce(v#> '{sms,kinds}', '{}'::jsonb) || jsonb_build_object(
      'spectacles_deferral',
      EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typname = 'sms_delivery_kind' AND e.enumlabel = 'spectacles_deferral'
      ),
      'surgery_deferral',
      EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typname = 'sms_delivery_kind' AND e.enumlabel = 'surgery_deferral'
      ),
      'spectacles_deferral_t1',
      EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typname = 'sms_delivery_kind' AND e.enumlabel = 'spectacles_deferral_t1'
      ),
      'surgery_deferral_t1',
      EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typname = 'sms_delivery_kind' AND e.enumlabel = 'surgery_deferral_t1'
      )
    )
  );
  RETURN v;
END;
$function$;

CREATE OR REPLACE FUNCTION public.latest_applied_migration()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$ SELECT '20260816240000'::text $$;
