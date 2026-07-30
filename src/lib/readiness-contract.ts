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
export const READINESS_CONTRACT_VERSION = 5;

/**
 * Latest migration version the app expects to be applied.
 * Matches `supabase/migrations/<version>_*.sql` head after #68 probe migration.
 */
export const EXPECTED_MIGRATION_HEAD = "20260729104500";

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
] as const;

/** table → required columns (runtime-critical subset). */
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
};

/** Functions that must exist (name only — signatures evolve; existence via pg_proc). */
export const REQUIRED_FUNCTIONS = [
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
 * `surgery_deferral` labels remain in the Postgres enum — a value cannot be
 * dropped from an enum type — but nothing produces them any more.
 */
export const SMS_DELIVERY_KINDS = ["registration", "reminder"] as const;

/** Safe operator explanations (no SQL, secrets, PHI, connection strings). */
export const CHECK_OPERATOR_HINTS: Readonly<Record<ReadinessCheckId, string>> =
  {
    database_reachability:
      "Database did not answer within the readiness budget. Check Supabase status and service-role configuration.",
    required_configuration:
      "AADHAAR_HASH_PEPPER is required for stable Person identity. Configure the existing production pepper; never rotate it during an active Camp.",
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
