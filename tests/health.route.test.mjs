/**
 * Behavioural coverage for GET /api/health (#14 rate limit + #68 fail-closed readiness).
 * Liveness (?ready absent) must never be rate-limited and never hit the DB.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "../src/app/api/health/route.ts";
import {
  EXPECTED_MIGRATION_HEAD,
  GRANT_EXPECTATIONS,
  READINESS_CONTRACT_VERSION,
  REQUIRED_COLUMNS,
  REQUIRED_FUNCTIONS,
  REQUIRED_INVARIANTS,
  REQUIRED_TABLES,
  SMS_DELIVERY_KINDS,
  SMS_DELIVERY_STATES,
} from "../src/lib/readiness-contract.ts";
import {
  __resetServiceRoleClient,
  __setServiceRoleClient,
} from "./stubs/service-role-admin.mjs";

function clearRateLimits() {
  globalThis.__snpRateLimits?.clear();
}

function healthRequest(path, ip) {
  return new Request(`http://127.0.0.1${path}`, {
    headers: { "x-forwarded-for": ip },
  });
}

/** Catalog facts that satisfy the versioned contract. */
function goodCatalogFacts(overrides = {}) {
  const tables = Object.fromEntries(REQUIRED_TABLES.map((name) => [name, true]));
  const columns = Object.fromEntries(
    Object.entries(REQUIRED_COLUMNS).flatMap(([table, names]) =>
      names.map((name) => [`${table}.${name}`, true]),
    ),
  );
  const functions = Object.fromEntries(
    REQUIRED_FUNCTIONS.map((name) => [name, true]),
  );
  const invariants = Object.fromEntries(
    REQUIRED_INVARIANTS.map((name) => [name, true]),
  );
  return {
    tables,
    columns,
    functions,
    invariants,
    grants: { ...GRANT_EXPECTATIONS },
    publication: { patients_in_supabase_realtime: false },
    sms: {
      table: true,
      states: {
        ...Object.fromEntries(SMS_DELIVERY_STATES.map((name) => [name, true])),
      },
      kinds: {
        ...Object.fromEntries(SMS_DELIVERY_KINDS.map((name) => [name, true])),
      },
      claim_fn: true,
      complete_fn: true,
    },
    ...overrides,
  };
}

/**
 * Minimal chainable supabase mock for readiness probes.
 * @param {object} opts
 */
function mockServiceRole({
  campsError = null,
  migrationVersion = EXPECTED_MIGRATION_HEAD,
  migrationError = null,
  catalogFacts = goodCatalogFacts(),
  catalogError = null,
  catalogDelayMs = 0,
  campsDelayMs = 0,
  migrationDelayMs = 0,
} = {}) {
  return {
    from(table) {
      const err =
        table === "camps" ? campsError : { message: "unknown table" };
      const chain = {
        select() {
          return chain;
        },
        async limit() {
          if (campsDelayMs > 0) {
            await new Promise((r) => setTimeout(r, campsDelayMs));
          }
          // Only camps is used for reachability in the new path.
          if (table !== "camps") {
            return { data: null, error: { message: "unknown table" } };
          }
          return { data: err ? null : [], error: err };
        },
      };
      return chain;
    },
    async rpc(name) {
      if (name === "latest_applied_migration") {
        if (migrationDelayMs > 0) {
          await new Promise((r) => setTimeout(r, migrationDelayMs));
        }
        if (migrationError) {
          return { data: null, error: migrationError };
        }
        return { data: migrationVersion, error: null };
      }
      if (name === "readiness_catalog_probe") {
        if (catalogDelayMs > 0) {
          await new Promise((r) => setTimeout(r, catalogDelayMs));
        }
        if (catalogError) {
          return { data: null, error: catalogError };
        }
        return { data: catalogFacts, error: null };
      }
      return { data: null, error: { message: `unknown rpc ${name}` } };
    },
  };
}

function assertNoSecrets(body) {
  const raw = JSON.stringify(body);
  // Safe operator codes may mention role names; ban credentials / URLs / SQL / PHI.
  assert.ok(!/postgres:\/\//i.test(raw));
  assert.ok(!/password[=:]|SUPABASE_SERVICE_ROLE_KEY|sb_secret_/i.test(raw));
  assert.ok(!/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i.test(raw));
  assert.ok(!/SELECT |INSERT |UPDATE |FROM public\./i.test(raw));
  assert.ok(!/"phone"\s*:\s*"\d{10}/.test(raw));
  assert.ok(!/status_token":"[0-9a-f]{32}/.test(raw));
}

test.beforeEach(() => {
  clearRateLimits();
  __resetServiceRoleClient();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
  process.env.AADHAAR_HASH_PEPPER = "health-route-test-pepper";
  process.env.RATE_LIMIT_SECRET = "health-route-test-rate-limit";
});

test.afterEach(() => {
  __resetServiceRoleClient();
});

test("thirteenth readiness probe in the window is 429", async () => {
  const ip = "198.51.100.10";
  const statuses = [];
  for (let i = 0; i < 13; i++) {
    const res = await GET(healthRequest("/api/health?ready=1", ip));
    statuses.push(res.status);
  }

  assert.ok(
    statuses.slice(0, 12).every((s) => s === 503 || s === 200),
    `first twelve should pass the rate gate, got ${statuses.slice(0, 12)}`,
  );
  assert.equal(statuses[12], 429);
});

test("liveness is never rate-limited across thirty requests", async () => {
  const ip = "198.51.100.20";
  for (let i = 0; i < 30; i++) {
    const res = await GET(healthRequest("/api/health", ip));
    assert.equal(res.status, 200, `liveness request ${i + 1} was ${res.status}`);
    const body = await res.json();
    assert.equal(body.ok, true);
    // Liveness must not surface readiness contract fields.
    assert.equal(body.contractVersion, undefined);
  }
});

test("ready-ok when fully aligned: 200 with all checks", async () => {
  __setServiceRoleClient(mockServiceRole());
  const res = await GET(
    healthRequest("/api/health?ready=1", "198.51.100.30"),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.contractVersion, READINESS_CONTRACT_VERSION);
  assert.equal(body.expectedMigrationHead, EXPECTED_MIGRATION_HEAD);
  assert.equal(body.appliedMigrationHead, EXPECTED_MIGRATION_HEAD);
  assert.equal(body.failedCheck, null);
  for (const id of [
    "database_reachability",
    "required_configuration",
    "migration_head_discovery",
    "applied_head_agreement",
    "schema_contract",
    "rpc_grants",
    "patients_realtime_absent",
    "sms_ledger",
  ]) {
    assert.equal(body.checks[id].ok, true, `${id} should pass`);
  }
  assert.equal(typeof body.smsConfigured, "boolean");
  assert.equal(typeof body.aadhaarConfigured, "boolean");
  assert.equal(typeof body.cronConfigured, "boolean");
  assertNoSecrets(body);
});

test("readiness returns 200 ready: true when optional integrations are unconfigured", async () => {
  __setServiceRoleClient(mockServiceRole());
  const prevSecret = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    const res = await GET(
      healthRequest("/api/health?ready=1", "198.51.100.99"),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.cronConfigured, false);
  } finally {
    if (prevSecret !== undefined) process.env.CRON_SECRET = prevSecret;
  }
});

test("missing Aadhaar Person pepper fails required configuration", async () => {
  __setServiceRoleClient(mockServiceRole());
  const previous = process.env.AADHAAR_HASH_PEPPER;
  delete process.env.AADHAAR_HASH_PEPPER;
  try {
    const res = await GET(
      healthRequest("/api/health?ready=1", "198.51.100.98"),
    );
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.failedCheck, "required_configuration");
    assert.equal(body.checks.required_configuration.ok, false);
    assert.equal(
      body.checks.required_configuration.code,
      "aadhaar_pepper_missing",
    );
  } finally {
    if (previous !== undefined) process.env.AADHAAR_HASH_PEPPER = previous;
  }
});


test("missing RATE_LIMIT_SECRET fails required configuration", async () => {
  __setServiceRoleClient(mockServiceRole());
  const previous = process.env.RATE_LIMIT_SECRET;
  delete process.env.RATE_LIMIT_SECRET;
  try {
    const res = await GET(
      healthRequest("/api/health?ready=1", "198.51.100.97"),
    );
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.failedCheck, "required_configuration");
    assert.equal(body.checks.required_configuration.ok, false);
    assert.equal(
      body.checks.required_configuration.code,
      "rate_limit_secret_missing",
    );
    assert.match(JSON.stringify(body), /RATE_LIMIT_SECRET/);
    assert.doesNotMatch(JSON.stringify(body), /health-route-test-rate-limit/);
  } finally {
    if (previous !== undefined) process.env.RATE_LIMIT_SECRET = previous;
  }
});

test("migration-head discovery failure → 503 (never 200)", async () => {
  __setServiceRoleClient(
    mockServiceRole({ migrationError: { message: "function missing" } }),
  );
  const res = await GET(
    healthRequest("/api/health?ready=1", "198.51.100.31"),
  );
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.checks.migration_head_discovery.ok, false);
  assert.equal(body.checks.migration_head_discovery.code, "discovery_failed");
  assert.equal(body.checks.applied_head_agreement.ok, false);
  assert.ok(
    body.failedCheck === "migration_head_discovery" ||
      body.failedCheck === "database_reachability" ||
      body.failedCheck === "applied_head_agreement",
  );
  // Must not expose raw SQL / provider errors as the only signal.
  assertNoSecrets(body);
});

test("repository/applied head mismatch → 503", async () => {
  __setServiceRoleClient(
    mockServiceRole({ migrationVersion: "19990101000000" }),
  );
  const res = await GET(
    healthRequest("/api/health?ready=1", "198.51.100.32"),
  );
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.checks.migration_head_discovery.ok, true);
  assert.equal(body.checks.applied_head_agreement.ok, false);
  assert.equal(body.checks.applied_head_agreement.code, "head_mismatch");
  assert.equal(body.appliedMigrationHead, "19990101000000");
  assert.equal(body.expectedMigrationHead, EXPECTED_MIGRATION_HEAD);
  assert.equal(body.failedCheck, "applied_head_agreement");
  assertNoSecrets(body);
});

test("missing critical function in catalog → 503", async () => {
  const facts = goodCatalogFacts();
  facts.functions = { ...facts.functions, upsert_camp_day: false };
  __setServiceRoleClient(mockServiceRole({ catalogFacts: facts }));
  const res = await GET(
    healthRequest("/api/health?ready=1", "198.51.100.33"),
  );
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.checks.schema_contract.ok, false);
  assert.equal(body.checks.schema_contract.code, "schema_missing");
  assert.match(body.checks.schema_contract.detail, /upsert_camp_day/);
  assertNoSecrets(body);
});

test("missing sms_deliveries table → 503 on schema and sms_ledger", async () => {
  const facts = goodCatalogFacts();
  facts.tables = { ...facts.tables, sms_deliveries: false };
  facts.sms = { ...facts.sms, table: false };
  __setServiceRoleClient(mockServiceRole({ catalogFacts: facts }));
  const res = await GET(
    healthRequest("/api/health?ready=1", "198.51.100.34"),
  );
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.checks.schema_contract.ok, false);
  assert.equal(body.checks.sms_ledger.ok, false);
  assertNoSecrets(body);
});

test("patients in Realtime publication → 503", async () => {
  const facts = goodCatalogFacts({
    publication: { patients_in_supabase_realtime: true },
  });
  __setServiceRoleClient(mockServiceRole({ catalogFacts: facts }));
  const res = await GET(
    healthRequest("/api/health?ready=1", "198.51.100.35"),
  );
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.checks.patients_realtime_absent.ok, false);
  assert.equal(body.failedCheck, "patients_realtime_absent");
  assertNoSecrets(body);
});

test("status_token grant to authenticated → 503 on rpc_grants", async () => {
  const facts = goodCatalogFacts();
  facts.grants = {
    ...facts.grants,
    patients_status_token_authenticated_select: true,
  };
  __setServiceRoleClient(mockServiceRole({ catalogFacts: facts }));
  const res = await GET(
    healthRequest("/api/health?ready=1", "198.51.100.36"),
  );
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.checks.rpc_grants.ok, false);
  assert.equal(body.checks.rpc_grants.code, "grant_mismatch");
  assertNoSecrets(body);
});

test("catalog probe RPC failure → 503", async () => {
  __setServiceRoleClient(
    mockServiceRole({ catalogError: { message: "permission denied" } }),
  );
  const res = await GET(
    healthRequest("/api/health?ready=1", "198.51.100.37"),
  );
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.checks.schema_contract.ok, false);
  assert.equal(body.checks.schema_contract.code, "catalog_probe_failed");
  assertNoSecrets(body);
});

test("database unreachable → 503", async () => {
  __setServiceRoleClient(
    mockServiceRole({ campsError: { message: "connection refused" } }),
  );
  const res = await GET(
    healthRequest("/api/health?ready=1", "198.51.100.38"),
  );
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.checks.database_reachability.ok, false);
  assert.equal(body.ok, false);
  assertNoSecrets(body);
});

test("probe timeout → 503 within budget", async () => {
  // Delay past READINESS_PROBE_TIMEOUT_MS (2500) but under overall (6000).
  __setServiceRoleClient(
    mockServiceRole({ migrationDelayMs: 3200 }),
  );
  const started = Date.now();
  const res = await GET(
    healthRequest("/api/health?ready=1", "198.51.100.39"),
  );
  const elapsed = Date.now() - started;
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.checks.migration_head_discovery.ok, false);
  assert.equal(body.checks.migration_head_discovery.code, "timeout");
  // Must fail well under a pathological hang (overall 6s + slack).
  assert.ok(elapsed < 7000, `elapsed ${elapsed}ms exceeded budget`);
  assertNoSecrets(body);
});

test("no service-role client → 503", async () => {
  // Default stub returns null.
  const res = await GET(
    healthRequest("/api/health?ready=1", "198.51.100.40"),
  );
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.checks.database_reachability.ok, false);
  assertNoSecrets(body);
});

test("non-critical historical object absent does not fail when not in contract", async () => {
  // Catalog may omit arbitrary historical keys; only contract keys matter.
  const facts = goodCatalogFacts();
  facts.tables = {
    ...facts.tables,
    // Historical / non-contract table absence is irrelevant.
  };
  facts.columns = {
    ...facts.columns,
    // No "patients.passcode" in contract — absence must not fail.
  };
  __setServiceRoleClient(mockServiceRole({ catalogFacts: facts }));
  const res = await GET(
    healthRequest("/api/health?ready=1", "198.51.100.41"),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});

test("no code path references app_database_contract", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve("src");
  /** @type {string[]} */
  const hits = [];
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|mjs)$/.test(ent.name)) {
        const text = fs.readFileSync(p, "utf8");
        if (text.includes("app_database_contract")) hits.push(p);
      }
    }
  }
  walk(root);
  assert.deepEqual(hits, [], `unexpected references: ${hits.join(", ")}`);
});
