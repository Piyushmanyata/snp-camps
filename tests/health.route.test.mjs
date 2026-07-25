/**
 * Behavioural coverage for GET /api/health (#14 rate limit + readiness).
 * Liveness (?ready absent) must never be rate-limited.
 * Phone OTP is no longer a readiness gate (#45 deleted patient self-reg).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "../src/app/api/health/route.ts";
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

/** Minimal chainable supabase mock for readiness probes. */
function mockServiceRole({
  campsError = null,
  profilesError = null,
  patientsError = null,
  migrationVersion = "20260725232000",
  migrationError = null,
} = {}) {
  return {
    from(table) {
      const err =
        table === "camps"
          ? campsError
          : table === "profiles"
            ? profilesError
            : table === "patients"
              ? patientsError
              : { message: "unknown table" };
      const chain = {
        select() {
          return chain;
        },
        limit() {
          return Promise.resolve({ data: err ? null : [], error: err });
        },
      };
      return chain;
    },
    rpc(name) {
      assert.equal(name, "latest_applied_migration");
      if (migrationError) {
        return Promise.resolve({ data: null, error: migrationError });
      }
      return Promise.resolve({ data: migrationVersion, error: null });
    },
  };
}

test.beforeEach(() => {
  clearRateLimits();
  __resetServiceRoleClient();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
});

test.afterEach(() => {
  __resetServiceRoleClient();
});

test("thirteenth readiness probe in the window is 429", async () => {
  // No service-role client → 503 after the rate-limit gate (unchanged #14).
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
  }
});

test("ready-ok reports migrationVersion from the ledger", async () => {
  __setServiceRoleClient(
    mockServiceRole({ migrationVersion: "20260725232000" }),
  );
  const res = await GET(
    healthRequest("/api/health?ready=1", "198.51.100.30"),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.checks.database, true);
  assert.equal(body.checks.phoneOtp, undefined);
  assert.equal(body.migrationVersion, "20260725232000");
});

test("ready-db-fail when a table-shape probe errors (503)", async () => {
  __setServiceRoleClient(
    mockServiceRole({ patientsError: { message: "relation missing" } }),
  );
  const res = await GET(
    healthRequest("/api/health?ready=1", "198.51.100.31"),
  );
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.checks.database, false);
  assert.equal(body.migrationVersion, "20260725232000");
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
