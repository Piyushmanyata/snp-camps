/**
 * Behavioural coverage for GET /api/health readiness rate limiting.
 * Liveness (?ready absent) must never be rate-limited.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "../src/app/api/health/route.ts";

function clearRateLimits() {
  globalThis.__snpRateLimits?.clear();
}

function healthRequest(path, ip) {
  return new Request(`http://127.0.0.1${path}`, {
    headers: { "x-forwarded-for": ip },
  });
}

test.beforeEach(() => {
  clearRateLimits();
  // No service-role key → readiness returns 503 after the rate-limit gate.
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
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
  }
});
