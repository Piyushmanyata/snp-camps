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
export const READINESS_CONTRACT_VERSION = 1;

/**
 * Latest migration version the app expects to be applied.
 * Matches `supabase/migrations/<version>_*.sql` head after #68 probe migration.
 */
export const EXPECTED_MIGRATION_HEAD = "20260728080000";

/** Bounded wait for each remote readiness probe (ms). */
export const READINESS_PROBE_TIMEOUT_MS = 2_500;

/** Overall budget for the readiness handler (ms). */
export const READINESS_OVERALL_TIMEOUT_MS = 6_000;

/** Stable check identifiers returned in JSON (machine-readable). */
export const READINESS_CHECK_IDS = [
  "database_reachability",
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
  "camps",
  "camp_days",
  "profiles",
  "sms_deliveries",
  "treatment_orders",
] as const;

/** table → required columns (runtime-critical subset). */
export const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  patients: [
    "id",
    "status_token",
    "queue_status",
    "queued_at",
    "reg_no",
    "camp_id",
    "camp_day_id",
    "full_name",
  ],
  camps: ["id", "name", "is_active", "venue"],
  camp_days: ["id", "camp_id", "day_date", "seat_limit", "theatre_capacity"],
  profiles: ["id", "disabled_at"],
  sms_deliveries: [
    "id",
    "patient_id",
    "kind",
    "state",
    "claim_token",
    "phone_last4",
    "attempt_count",
    "updated_at",
  ],
  treatment_orders: ["id", "scheduled_camp_day_id"],
};

/** Functions that must exist (name only — signatures evolve; existence via pg_proc). */
export const REQUIRED_FUNCTIONS = [
  "latest_applied_migration",
  "readiness_catalog_probe",
  "patient_status_by_token",
  "upsert_camp_day",
  "register_patient_idempotent",
  "check_in_patient",
  "claim_sms_delivery",
  "complete_sms_delivery",
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
  register_patient_idempotent_authenticated_execute: true,
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

export const SMS_DELIVERY_KINDS = [
  "registration",
  "reminder",
  "spectacles_deferral",
  "surgery_deferral",
] as const;

/** Safe operator explanations (no SQL, secrets, PHI, connection strings). */
export const CHECK_OPERATOR_HINTS: Readonly<Record<ReadinessCheckId, string>> =
  {
    database_reachability:
      "Database did not answer within the readiness budget. Check Supabase status and service-role configuration.",
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
