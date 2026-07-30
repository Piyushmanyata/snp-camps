/**
 * Fail-closed readiness evaluation (#68).
 * Produces independent check results; any failure / unknown → not ready.
 * Never includes secrets, SQL text, PHI, or connection strings in output.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CHECK_OPERATOR_HINTS,
  EXPECTED_MIGRATION_HEAD,
  GRANT_EXPECTATIONS,
  PUBLICATION_EXPECTATIONS,
  READINESS_CHECK_IDS,
  READINESS_CONTRACT_VERSION,
  READINESS_OVERALL_TIMEOUT_MS,
  READINESS_PROBE_TIMEOUT_MS,
  REQUIRED_COLUMNS,
  REQUIRED_FUNCTIONS,
  REQUIRED_INVARIANTS,
  REQUIRED_TABLES,
  SMS_DELIVERY_KINDS,
  SMS_DELIVERY_STATES,
  type ReadinessCheckId,
} from "@/lib/readiness-contract";

export type CheckResult = {
  ok: boolean;
  /** Stable machine code when not ok (or when ok with extra context). */
  code?: string;
  /** Safe operator explanation — never secrets/PHI/SQL. */
  detail?: string;
};

export type ReadinessResult = {
  ok: boolean;
  contractVersion: number;
  expectedMigrationHead: string;
  appliedMigrationHead: string | null;
  checks: Record<ReadinessCheckId, CheckResult>;
  /** First failed check id, if any. */
  failedCheck: ReadinessCheckId | null;
  integrations: {
    sms: boolean;
    /**
     * The Aadhaar pepper. eKYC provider configuration was retired with the OTP
     * flow (#116); the pepper survives because the Person duplicate key is
     * keyed on it, so a scanned registration cannot proceed without it.
     */
    aadhaarPepper: boolean;
    cron: boolean;
  };
};

export function integrationConfig(env: Record<string, string | undefined> = process.env) {
  return {
    sms: Boolean(
      env.MSG91_AUTH_KEY?.trim() &&
        env.MSG91_SENDER_ID?.trim() &&
        (env.MSG91_DLT_TE_ID_REGISTRATION?.trim() || env.MSG91_TEMPLATE_REGISTRATION?.trim()) &&
        (env.MSG91_DLT_TE_ID_REMINDER?.trim() || env.MSG91_TEMPLATE_REMINDER?.trim()),
    ),
    aadhaarPepper: Boolean(env.AADHAAR_HASH_PEPPER?.trim()),
    cron: Boolean(env.CRON_SECRET?.trim()),
  };
}

/** Facts returned by public.readiness_catalog_probe() (service_role). */
export type CatalogProbeFacts = {
  tables?: Record<string, boolean>;
  columns?: Record<string, boolean>;
  functions?: Record<string, boolean>;
  invariants?: Record<string, boolean>;
  grants?: Record<string, boolean>;
  publication?: { patients_in_supabase_realtime?: boolean };
  sms?: {
    table?: boolean;
    states?: Record<string, boolean>;
    kinds?: Record<string, boolean>;
    claim_fn?: boolean;
    complete_fn?: boolean;
  };
};

type ServiceClient = Pick<SupabaseClient, "from" | "rpc">;

function fail(
  code: string,
  checkId: ReadinessCheckId,
  extra?: string,
): CheckResult {
  const base = CHECK_OPERATOR_HINTS[checkId];
  return {
    ok: false,
    code,
    detail: extra ? `${base} (${extra})` : base,
  };
}

function pass(code?: string, detail?: string): CheckResult {
  return code || detail ? { ok: true, code, detail } : { ok: true };
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error(`timeout:${label}`), { code: "timeout" })),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isTimeout(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.message.startsWith("timeout:") ||
      (err as { code?: string }).code === "timeout")
  );
}

function emptyChecks(seed: CheckResult): Record<ReadinessCheckId, CheckResult> {
  const checks = {} as Record<ReadinessCheckId, CheckResult>;
  for (const id of READINESS_CHECK_IDS) {
    checks[id] = { ...seed, detail: seed.detail ?? CHECK_OPERATOR_HINTS[id] };
  }
  return checks;
}

function firstFailed(
  checks: Record<ReadinessCheckId, CheckResult>,
): ReadinessCheckId | null {
  for (const id of READINESS_CHECK_IDS) {
    if (!checks[id].ok) return id;
  }
  return null;
}

function allOk(checks: Record<ReadinessCheckId, CheckResult>): boolean {
  return READINESS_CHECK_IDS.every((id) => checks[id].ok);
}

/** Evaluate catalog facts against the versioned contract. */
export function evaluateCatalogFacts(facts: CatalogProbeFacts | null | undefined): {
  schema_contract: CheckResult;
  rpc_grants: CheckResult;
  patients_realtime_absent: CheckResult;
  sms_ledger: CheckResult;
} {
  if (!facts || typeof facts !== "object") {
    return {
      schema_contract: fail("catalog_probe_empty", "schema_contract"),
      rpc_grants: fail("catalog_probe_empty", "rpc_grants"),
      patients_realtime_absent: fail(
        "catalog_probe_empty",
        "patients_realtime_absent",
      ),
      sms_ledger: fail("catalog_probe_empty", "sms_ledger"),
    };
  }

  const missingTables: string[] = [];
  for (const t of REQUIRED_TABLES) {
    if (!facts.tables?.[t]) missingTables.push(t);
  }

  const missingColumns: string[] = [];
  for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
    for (const col of cols) {
      const key = `${table}.${col}`;
      if (!facts.columns?.[key]) missingColumns.push(key);
    }
  }

  const missingFns: string[] = [];
  for (const fn of REQUIRED_FUNCTIONS) {
    if (!facts.functions?.[fn]) missingFns.push(fn);
  }

  const missingInvariants: string[] = [];
  for (const invariant of REQUIRED_INVARIANTS) {
    if (!facts.invariants?.[invariant]) missingInvariants.push(invariant);
  }

  const schemaMissing = [
    ...missingTables.map((t) => `table:${t}`),
    ...missingColumns.map((c) => `column:${c}`),
    ...missingFns.map((f) => `function:${f}`),
    ...missingInvariants.map((name) => `invariant:${name}`),
  ];

  const schema_contract =
    schemaMissing.length === 0
      ? pass("schema_ok")
      : fail(
          "schema_missing",
          "schema_contract",
          `missing=${schemaMissing.slice(0, 8).join(",")}${schemaMissing.length > 8 ? ",…" : ""}`,
        );

  const grantMismatches: string[] = [];
  for (const [key, expected] of Object.entries(GRANT_EXPECTATIONS)) {
    const actual = facts.grants?.[key];
    if (typeof actual !== "boolean" || actual !== expected) {
      grantMismatches.push(key);
    }
  }
  const rpc_grants =
    grantMismatches.length === 0
      ? pass("grants_ok")
      : fail(
          "grant_mismatch",
          "rpc_grants",
          `mismatch=${grantMismatches.slice(0, 6).join(",")}${grantMismatches.length > 6 ? ",…" : ""}`,
        );

  const inPub = facts.publication?.patients_in_supabase_realtime;
  const patients_realtime_absent =
    typeof inPub === "boolean" &&
    inPub === PUBLICATION_EXPECTATIONS.patients_in_supabase_realtime
      ? pass("realtime_ok")
      : fail(
          typeof inPub !== "boolean" ? "publication_unknown" : "patients_in_realtime",
          "patients_realtime_absent",
        );

  const sms = facts.sms;
  const smsIssues: string[] = [];
  if (!sms?.table) smsIssues.push("table");
  if (!sms?.claim_fn) smsIssues.push("claim_sms_delivery");
  if (!sms?.complete_fn) smsIssues.push("complete_sms_delivery");
  for (const s of SMS_DELIVERY_STATES) {
    if (!sms?.states?.[s]) smsIssues.push(`state:${s}`);
  }
  for (const k of SMS_DELIVERY_KINDS) {
    if (!sms?.kinds?.[k]) smsIssues.push(`kind:${k}`);
  }
  const sms_ledger =
    smsIssues.length === 0
      ? pass("sms_ledger_ok")
      : fail(
          "sms_ledger_incomplete",
          "sms_ledger",
          `missing=${smsIssues.slice(0, 8).join(",")}`,
        );

  return {
    schema_contract,
    rpc_grants,
    patients_realtime_absent,
    sms_ledger,
  };
}

/**
 * Run fail-closed readiness against a service-role Supabase client.
 * Any null/timeout/error → corresponding check fails → overall not ready.
 */
export async function evaluateReadiness(
  client: ServiceClient | null,
): Promise<ReadinessResult> {
  const base: Omit<ReadinessResult, "ok" | "checks" | "failedCheck"> = {
    contractVersion: READINESS_CONTRACT_VERSION,
    expectedMigrationHead: EXPECTED_MIGRATION_HEAD,
    appliedMigrationHead: null,
    integrations: integrationConfig(),
  };

  if (!client) {
    const checks = emptyChecks(
      fail("service_role_unconfigured", "database_reachability"),
    );
    // Only reachability is specifically about missing client; others cascade.
    for (const id of READINESS_CHECK_IDS) {
      if (id !== "database_reachability") {
        checks[id] = fail("service_role_unconfigured", id);
      }
    }
    checks.required_configuration = base.integrations.aadhaarPepper
      ? pass("required_configuration_ok")
      : fail("aadhaar_pepper_missing", "required_configuration");
    return {
      ...base,
      ok: false,
      checks,
      failedCheck: "database_reachability",
    };
  }

  try {
    return await withTimeout(
      evaluateReadinessInner(client, base),
      READINESS_OVERALL_TIMEOUT_MS,
      "readiness_overall",
    );
  } catch (err) {
    const checks = emptyChecks(
      fail(
        isTimeout(err) ? "timeout" : "readiness_error",
        "database_reachability",
      ),
    );
    return {
      ...base,
      ok: false,
      checks,
      failedCheck: "database_reachability",
    };
  }
}

async function evaluateReadinessInner(
  client: ServiceClient,
  base: Omit<ReadinessResult, "ok" | "checks" | "failedCheck">,
): Promise<ReadinessResult> {
  const checks = {} as Record<ReadinessCheckId, CheckResult>;

  // 1) Database reachability — cheap table probe.
  // Promise.resolve: PostgREST builders are thenable but not typed as Promise.
  try {
    const camps = await withTimeout(
      Promise.resolve(client.from("camps").select("id").limit(1)),
      READINESS_PROBE_TIMEOUT_MS,
      "database_reachability",
    );
    if (camps.error) {
      checks.database_reachability = fail(
        "database_query_failed",
        "database_reachability",
      );
    } else {
      checks.database_reachability = pass("reachable");
    }
  } catch (err) {
    checks.database_reachability = fail(
      isTimeout(err) ? "timeout" : "database_unreachable",
      "database_reachability",
    );
  }

  checks.required_configuration = base.integrations.aadhaarPepper
    ? pass("required_configuration_ok")
    : fail("aadhaar_pepper_missing", "required_configuration");

  // 2) Migration-head discovery — failure is not ready (never coerce to null success).
  let applied: string | null = null;
  try {
    const mig = await withTimeout(
      Promise.resolve(client.rpc("latest_applied_migration")),
      READINESS_PROBE_TIMEOUT_MS,
      "migration_head_discovery",
    );
    if (mig.error) {
      checks.migration_head_discovery = fail(
        "discovery_failed",
        "migration_head_discovery",
      );
    } else if (typeof mig.data !== "string" || mig.data.length === 0) {
      checks.migration_head_discovery = fail(
        "discovery_empty",
        "migration_head_discovery",
      );
    } else {
      applied = mig.data;
      checks.migration_head_discovery = pass("discovered");
    }
  } catch (err) {
    checks.migration_head_discovery = fail(
      isTimeout(err) ? "timeout" : "discovery_error",
      "migration_head_discovery",
    );
  }

  // 3) Applied-head agreement — requires successful discovery.
  if (!checks.migration_head_discovery.ok || applied === null) {
    checks.applied_head_agreement = fail(
      "discovery_unavailable",
      "applied_head_agreement",
      `expected=${EXPECTED_MIGRATION_HEAD}`,
    );
  } else if (applied !== EXPECTED_MIGRATION_HEAD) {
    checks.applied_head_agreement = fail(
      "head_mismatch",
      "applied_head_agreement",
      `expected=${EXPECTED_MIGRATION_HEAD}, applied=${applied}`,
    );
  } else {
    checks.applied_head_agreement = pass("heads_agree", `head=${applied}`);
  }

  // 4–7) Catalog contract via single probe RPC (or fail closed).
  let catalogEval = evaluateCatalogFacts(null);
  try {
    const probe = await withTimeout(
      Promise.resolve(client.rpc("readiness_catalog_probe")),
      READINESS_PROBE_TIMEOUT_MS,
      "catalog_probe",
    );
    if (probe.error) {
      const f = fail("catalog_probe_failed", "schema_contract");
      catalogEval = {
        schema_contract: f,
        rpc_grants: fail("catalog_probe_failed", "rpc_grants"),
        patients_realtime_absent: fail(
          "catalog_probe_failed",
          "patients_realtime_absent",
        ),
        sms_ledger: fail("catalog_probe_failed", "sms_ledger"),
      };
    } else {
      const facts =
        typeof probe.data === "string"
          ? (JSON.parse(probe.data) as CatalogProbeFacts)
          : (probe.data as CatalogProbeFacts);
      catalogEval = evaluateCatalogFacts(facts);
    }
  } catch (err) {
    const code = isTimeout(err) ? "timeout" : "catalog_probe_error";
    catalogEval = {
      schema_contract: fail(code, "schema_contract"),
      rpc_grants: fail(code, "rpc_grants"),
      patients_realtime_absent: fail(code, "patients_realtime_absent"),
      sms_ledger: fail(code, "sms_ledger"),
    };
  }

  checks.schema_contract = catalogEval.schema_contract;
  checks.rpc_grants = catalogEval.rpc_grants;
  checks.patients_realtime_absent = catalogEval.patients_realtime_absent;
  checks.sms_ledger = catalogEval.sms_ledger;

  // If DB is unreachable, mark dependent checks failed even if somehow ok.
  if (!checks.database_reachability.ok) {
    for (const id of READINESS_CHECK_IDS) {
      if (id === "database_reachability" || id === "required_configuration") {
        continue;
      }
      if (checks[id].ok) {
        checks[id] = fail("database_unreachable", id);
      }
    }
  }

  return {
    ...base,
    appliedMigrationHead: applied,
    ok: allOk(checks),
    checks,
    failedCheck: firstFailed(checks),
  };
}

/** JSON body for HTTP response — only safe fields. */
export function readinessResponseBody(result: ReadinessResult) {
  return {
    ok: result.ok,
    contractVersion: result.contractVersion,
    expectedMigrationHead: result.expectedMigrationHead,
    appliedMigrationHead: result.appliedMigrationHead,
    checks: result.checks,
    failedCheck: result.failedCheck,
    smsConfigured: result.integrations.sms,
    aadhaarConfigured: result.integrations.aadhaarPepper,
    cronConfigured: result.integrations.cron,
  };
}
