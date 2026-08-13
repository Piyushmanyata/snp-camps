/**
 * Behavioural coverage for the public patient lookup boundary (#114).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../src/app/api/lookup/route.ts";
import {
  __resetServiceRoleClient,
  __setServiceRoleClient,
} from "./stubs/service-role-admin.mjs";

process.env.SUPABASE_SERVICE_ROLE_KEY ||= "lookup-route-test-secret";
process.env.RATE_LIMIT_SECRET ||= "lookup-rate-limit-secret";

function fakeClient({ rateAllowed = true, rateError = null } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      async rpc(functionName, args) {
        calls.push({ functionName, args });
        if (functionName === "consume_public_rate_limit") {
          return {
            data: rateError
              ? null
              : [{ allowed: rateAllowed, retry_after_seconds: 30 }],
            error: rateError,
          };
        }
        if (functionName === "lookup_patient_status_token") {
          return {
            data: [{ status_token: "status-token-123" }],
            error: null,
          };
        }
        throw new Error(`Unexpected RPC ${functionName}`);
      },
    },
  };
}

function post(body, address = `10.20.0.${Math.floor(Math.random() * 200) + 1}`) {
  return POST(
    new Request("http://localhost/api/lookup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": address,
      },
      body: JSON.stringify(body),
    }),
  );
}

test.afterEach(() => {
  __resetServiceRoleClient();
});

test("lookup consumes the distributed limit before resolving a status token", async () => {
  const fake = fakeClient();
  __setServiceRoleClient(fake.client);

  const response = await post({
    regNo: 4242,
    dateOfBirth: "1980-01-02",
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.redirectUrl, "/s/status-token-123");
  assert.deepEqual(
    fake.calls.map((call) => call.functionName),
    ["consume_public_rate_limit", "lookup_patient_status_token"],
  );
  assert.equal(fake.calls[0].args.p_scope, "patient-lookup");
  assert.equal(fake.calls[0].args.p_limit, 5);
  assert.equal(fake.calls[0].args.p_key_hashes.length, 2);
  assert.ok(
    fake.calls[0].args.p_key_hashes.every((value) =>
      /^[A-Za-z0-9_-]{20,64}$/.test(value),
    ),
    "the database must receive only keyed digests",
  );
});

test("a distributed denial never reaches the token lookup", async () => {
  const fake = fakeClient({ rateAllowed: false });
  __setServiceRoleClient(fake.client);

  const response = await post(
    { regNo: 4242, dateOfBirth: "1980-01-02" },
    "10.21.0.1",
  );

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "30");
  assert.deepEqual(
    fake.calls.map((call) => call.functionName),
    ["consume_public_rate_limit"],
  );
});

test("a distributed limiter failure is fail-closed", async () => {
  const fake = fakeClient({ rateError: { message: "database unavailable" } });
  __setServiceRoleClient(fake.client);

  const response = await post(
    { regNo: 4242, dateOfBirth: "1980-01-02" },
    "10.22.0.1",
  );

  assert.equal(response.status, 503);
  assert.deepEqual(
    fake.calls.map((call) => call.functionName),
    ["consume_public_rate_limit"],
  );
});

test("oversized JSON is rejected before service-role work", async () => {
  const fake = fakeClient();
  __setServiceRoleClient(fake.client);

  const response = await post({
    regNo: 4242,
    dateOfBirth: "1980-01-02",
    padding: "x".repeat(2_000),
  });

  assert.equal(response.status, 400);
  assert.equal(fake.calls.length, 0);
});
