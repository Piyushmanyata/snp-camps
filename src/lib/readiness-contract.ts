/**
 * Versioned runtime-critical database/catalog contract for readiness (#68).
 *
 * This is NOT a full historical schema dump. Only objects the running app
 * requires at runtime: lifecycle tables/columns, concurrency RPCs, status
 * projection, SMS ledger, least-privilege grants, and Realtime publication.
 *
 * EXPECTED_MIGRATION_HEAD must match the latest file under supabase/migrations/
 * (version prefix). Bump both when a new migration lands.
 */

/** Bump when the set of required facts or expectations changes. */
export const READINESS_CONTRACT_VERSION = 9;

/**
 * Latest migration version the app expects to be applied.
 * Matches `supabase/migrations/<version>_*.sql` head after #68 probe migration.
 */
export const EXPECTED_MIGRATION_HEAD = "20260810120000";

/** Bounded wait for each remote readiness probe (ms). */
export const READINESS_PROBE_TIMEOUT_MS = 2_500;

/** Overall budget for the readiness handler (ms). */
export const READINESS_OVERALL_TIMEOUT_MS = 6_000;

/** Stable check identifiers returned in JSON (machine-readable). */
export const READINESS_CHECK_IDS = [
  "database_reachability",
  "required_configuration",
  "migration_head_discovery",
  "applied_head_agreement",
  "schema_contract",
  "rpc_grants",
  "patients_realtime_absent",
  "sms_ledger",
] as const;

export type ReadinessCheckId = (typeof READINESS_CHECK_IDS)[number];

export const REQUIRED_TABLES = [
  "patients",
  "persons",
  "camps",
  "camp_days",
  "profiles",
  "sms_deliveries",
  "public_rate_limit_buckets",
  "prescription_transcriptions",
  "prescription_corrections",
  "fulfilment_items",
  "fulfilment_events",
  "deferred_slips",
  "prescription_template_versions",
  "sponsor_assets",
  "aadhaar_extraction_events",
] as const;

/** table ΓåÆ required columns (runtime-critical subset). */
export const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  patients: [
    "id",
    "status_token",
    "queue_status",
    "queued_at",
    "printed_at",
    "seen_at",
    "seen_by",
    "reg_no",
    "camp_id",
    "camp_day_id",
    "full_name",
    "display_name",
    "person_id",
    "provenance",
    "phone_provenance",
  ],
  persons: [
    "id",
    "reg_no",
    "full_name",
    "display_name",
    "gender",
    "date_of_birth",
    "aadhaar_last4",
    "duplicate_key",
    "aadhaar_locked_at",
    "name_locked_at",
  ],
  camps: ["id", "name", "is_active", "venue", "prescription_template"],
  camp_days: ["id", "camp_id", "day_date", "seat_limit"],
  profiles: ["id", "role", "disabled_at", "team_lead_id"],
  sms_deliveries: [
    "id",
    "patient_id",
    "kind",
    "state",
    "claim_token",
    "phone_last4",
    "attempt_count",
    "dispatch_started_at",
    "updated_at",
  ],
  public_rate_limit_buckets: [
    "scope",
    "key_hash",
    "window_started_at",
    "attempts",
    "expires_at",
  ],
  prescription_transcriptions: [
    "id", "patient_id", "data", "paper_source", "created_by", "created_at",
    "updated_by", "updated_at", "locked_at", "archived_at",
  ],
  prescription_corrections: [
    "id", "transcription_id", "reason", "correction_kind", "replacement_data",
    "created_by", "created_at",
  ],
  fulfilment_items: [
    "id", "transcription_id", "kind", "outcome", "current_version",
    "resolved_by", "resolved_at", "unavailable_medicines",
  ],
  fulfilment_events: [
    "id", "item_id", "event", "from_outcome", "to_outcome", "reason",
    "created_by", "created_at",
  ],
  deferred_slips: [
    "id", "item_id", "reference", "version", "service", "date_snapshot",
    "venue_snapshot", "issued_by", "issued_at", "status", "replaced_by",
  ],
  prescription_template_versions: [
    "id", "camp_id", "version", "status", "template", "created_by",
    "created_at", "published_at",
  ],
  sponsor_assets: [
    "id", "camp_id", "object_key", "mime_type", "byte_size", "created_by",
    "created_at", "state", "state_changed_at", "cleanup_attempts", "last_error_code",
  ],
  aadhaar_extraction_events: [
    "id", "patient_id", "consent_at", "method", "trust_level", "outcome",
    "aadhaar_last4", "created_at",
  ],
};

/** Runtime functions; the catalog probe verifies exact overload signatures. */
export const REQUIRED_FUNCTIONS = [
  "is_clinical_operator",
  "assert_valid_clinical_data",
  "clinical_lookup",
  "clinical_save_transcription",
  "clinical_add_correction",
  "clinical_resolve_item",
  "clinical_followup_fulfil",
  "clinical_followup_lookup",
  "clinical_slip_by_id",
  "clinical_replace_slip",
  "admin_prescription_template_editor",
  "admin_save_prescription_template",
  "admin_clinical_records",
  "admin_clinical_export",
  "admin_archive_transcription",
  "admin_reverse_fulfilment",
  "published_prescription_template",
  "audit_scanned_aadhaar_registration",
  "latest_applied_migration",
  "readiness_catalog_probe",
  "patient_status_by_token",
  "upsert_camp_day",
  "register_patient_idempotent",
  "check_in_patient",
  "lookup_patient_scan",
  "mark_seen",
  "undo_mark_seen",
  "lookup_patient_status_token",
  "consume_public_rate_limit",
  "active_registration_id",
  "staff_person_kpis",
  "claim_sms_delivery",
  "mark_sms_dispatch_started",
  "complete_sms_delivery",
  "patient_registration_notify_fields",
  "camp_queue_counts",
  "search_desk_patients",
  "desk_waiting_queue",
  "print_patient",
  "staff_registered_patients",
  "begin_sponsor_asset_deletion",
  "finish_sponsor_asset_deletion",
] as const;

/** Catalog invariants that cannot be proven by table/column presence alone. */
export const REQUIRED_INVARIANTS = [
  "patients_camp_reg_no_unique",
  "patients_person_camp_unique",
  "patients_person_id_not_null",
  "patients_provenance_current",
  "patients_phone_provenance_current",
  "retired_ekyc_storage_absent",
  "register_rpc_supported_signatures_only",
  "staff_kpi_single_contract",
  "staff_leaderboard_absent",
  "migration_head_current",
  "profiles_team_lead_fk",
  "team_membership_guards",
  "prescription_records_absent",
  "doctor_station_retired",
  "mark_seen_contract",
  "public_rate_limit_primary_key",
  "transcription_patient_unique",
  "fulfilment_kind_unique",
  "deferred_one_active",
  "template_one_published",
  "template_one_draft",
  "sponsor_object_key_unique",
  "sponsor_state_check",
  "aadhaar_event_patient_unique",
  "clinical_rls_enabled",
  "sponsor_bucket_private",
  "sponsor_bucket_restrictions",
] as const;

/**
 * Grant / privilege expectations as boolean facts.
 * Keys match facts returned by readiness_catalog_probe().
 * true = privilege must be present; false = privilege must be absent.
 */
export const GRANT_EXPECTATIONS: Readonly<Record<string, boolean>> = {
  // Bearer status tokens are not selectable by ordinary authenticated sessions (#56).
  patients_status_token_authenticated_select: false,
  // Status page uses service_role only (#70).
  patient_status_by_token_authenticated_execute: false,
  patient_status_by_token_anon_execute: false,
  patient_status_by_token_service_role_execute: true,
  // SMS ledger is service/staff RPC only; no direct authenticated table select (#65).
  sms_deliveries_authenticated_select: false,
  claim_sms_delivery_service_role_execute: true,
  complete_sms_delivery_service_role_execute: true,
  // Capacity + desk RPCs remain available to authenticated staff.
  upsert_camp_day_authenticated_execute: true,
  check_in_patient_authenticated_execute: true,
  lookup_patient_scan_authenticated_execute: true,
  search_desk_patients_authenticated_execute: true,
  search_desk_patients_anon_execute: false,
  // The two desk actions (D22). Never reachable without a signed-in staff session.
  mark_seen_authenticated_execute: true,
  mark_seen_anon_execute: false,
  undo_mark_seen_authenticated_execute: true,
  register_patient_idempotent_authenticated_execute: true,
  lookup_patient_status_token_anon_execute: false,
  lookup_patient_status_token_authenticated_execute: false,
  lookup_patient_status_token_service_role_execute: true,
  consume_public_rate_limit_anon_execute: false,
  consume_public_rate_limit_authenticated_execute: false,
  consume_public_rate_limit_service_role_execute: true,
  staff_person_kpis_authenticated_execute: true,
  staff_person_kpis_anon_execute: false,
  staff_person_kpis_service_role_execute: true,
  staff_leaderboard_authenticated_execute: false,
  mark_sms_dispatch_started_authenticated_execute: true,
  mark_sms_dispatch_started_service_role_execute: true,
  patient_registration_notify_fields_authenticated_execute: true,
  camp_queue_counts_authenticated_execute: true,
  camp_queue_counts_anon_execute: false,
  camp_queue_counts_service_role_execute: true,
  latest_applied_migration_service_role_execute: true,
  // persons is server-only: duplicate_key is the pepper-derived Person key.
  persons_authenticated_select: false,
  // persons is server-only: duplicate_key is the pepper-derived Person key.
  persons_authenticated_write: false,
  // Patients list is not open to every authenticated role; desks use RPCs.
  patients_authenticated_select: false,
  prescription_transcriptions_authenticated_write: false,
  prescription_corrections_authenticated_write: false,
  fulfilment_items_authenticated_write: false,
  fulfilment_events_authenticated_write: false,
  deferred_slips_authenticated_write: false,
  prescription_template_versions_authenticated_write: false,
  sponsor_assets_authenticated_write: false,
  aadhaar_extraction_events_authenticated_write: false,
  aadhaar_extraction_events_authenticated_access: false,
  prescription_transcriptions_anon_access: false,
  prescription_corrections_anon_access: false,
  fulfilment_items_anon_access: false,
  fulfilment_events_anon_access: false,
  deferred_slips_anon_access: false,
  prescription_template_versions_anon_access: false,
  sponsor_assets_anon_access: false,
  aadhaar_extraction_events_anon_access: false,
  clinical_callable_authenticated_execute: true,
  clinical_callable_service_role_execute: true,
  clinical_internal_anon_execute: false,
  clinical_callable_public_execute: false,
  assert_valid_clinical_data_authenticated_execute: false,
  assert_valid_clinical_data_anon_execute: false,
  assert_valid_clinical_data_service_role_execute: true,
  audit_scanned_aadhaar_authenticated_execute: false,
  audit_scanned_aadhaar_anon_execute: false,
  audit_scanned_aadhaar_service_role_execute: true,
  desk_waiting_queue_authenticated_execute: true,
  print_patient_authenticated_execute: true,
  staff_registered_patients_authenticated_execute: true,
  begin_sponsor_asset_deletion_authenticated_execute: true,
  finish_sponsor_asset_deletion_authenticated_execute: true,
};

/** patients must NOT be in supabase_realtime after #56. */
export const PUBLICATION_EXPECTATIONS = {
  patients_in_supabase_realtime: false,
} as const;

/** SMS ledger enum states the app relies on (#65). */
export const SMS_DELIVERY_STATES = [
  "pending",
  "sending",
  "sent",
  "failed",
  "ambiguous",
] as const;

/**
 * Only the two kinds the app still sends (D28). The `spectacles_deferral` and
 * `surgery_deferral` labels remain in the Postgres enum ΓÇö a value cannot be
 * dropped from an enum type ΓÇö but nothing produces them any more.
 */
export const SMS_DELIVERY_KINDS = ["registration", "reminder"] as const;

/** Safe operator explanations (no SQL, secrets, PHI, connection strings). */
export const CHECK_OPERATOR_HINTS: Readonly<Record<ReadinessCheckId, string>> =
  {
    database_reachability:
      "Database did not answer within the readiness budget. Check Supabase status and service-role configuration.",
    required_configuration:
      "AADHAAR_HASH_PEPPER is required for stable Person identity, and RATE_LIMIT_SECRET is required for durable public rate limiting. Without RATE_LIMIT_SECRET every /s/<token> status link returns 404 and self-registration and patient lookup fail closed. Configure the existing production values; never rotate the pepper during an active Camp.",
    migration_head_discovery:
      "Could not read the applied migration ledger. Treat the environment as not ready until discovery succeeds.",
    applied_head_agreement:
      "Applied migration head does not match the repository contract head. Apply pending migrations on a controlled path; never auto-repair production from readiness.",
    schema_contract:
      "A runtime-critical table, column, or function from the readiness contract is missing. Re-run clean migration replay on a disposable database and compare heads.",
    rpc_grants:
      "Least-privilege grant expectations failed (status token, status RPC, SMS ledger, or staff RPCs). Review recent privilege migrations; do not widen grants casually.",
    patients_realtime_absent:
      "patients appears in the supabase_realtime publication. Product is poll-only after #56; drop the table from the publication.",
    sms_ledger:
      "Durable SMS delivery ledger (#65) is incomplete (table, states, or claim/complete RPCs). Apply migrations through the SMS ledger head.",
  };
