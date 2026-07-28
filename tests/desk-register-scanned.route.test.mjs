import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../src/app/api/desk/register-scanned/route.ts";
import { __resetCookies, __setCookies } from "./stubs/next-headers.mjs";
import {
  __resetAuthMock,
  __setAuthMock,
} from "./stubs/supabase-ssr.mjs";
import {
  __resetServiceRoleClient,
  __setServiceRoleClient,
} from "./stubs/service-role-admin.mjs";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CAMP_ID = "22222222-2222-4222-8222-222222222222";
const DAY_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";

process.env.AADHAAR_HASH_PEPPER ||= "desk-route-test-pepper";

function validBody(overrides = {}) {
  return {
    requestId: REQUEST_ID,
    campId: CAMP_ID,
    campDayId: DAY_ID,
    fullName: "Ramesh Kumar",
    displayName: "",
    gender: "M",
    age: 50,
    address: "Sikar",
    phone: "9876543210",
    email: "",
    aadhaarLast4: "9999",
    dateOfBirth: "1976-05-15",
    ...overrides,
  };
}

function request(body, contentType = "application/json") {
  return new Request("http://localhost/api/desk/register-scanned", {
    method: "POST",
    headers: { "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function signIn(role = "volunteer") {
  __setCookies([{ name: "sb-test-auth-token", value: "session" }]);
  __setAuthMock({
    userId: USER_ID,
    profile: {
      id: USER_ID,
      role,
      full_name: "Desk User",
      disabled_at: null,
    },
  });
}

test.beforeEach(() => {
  __resetCookies();
  __resetAuthMock();
  __resetServiceRoleClient();
});

test("derives a Person key server-side and forces trusted staff semantics", async () => {
  signIn("team_lead");
  const calls = [];
  __setServiceRoleClient({
    rpc(fn, args) {
      calls.push({ fn, args });
      return Promise.resolve({
        data: [{ id: "55555555-5555-4555-8555-555555555555", reg_no: 71 }],
        error: null,
      });
    },
  });

  const response = await POST(request(validBody()));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.error, null);
  assert.equal(calls.length, 1);
  const { args } = calls[0];
  assert.equal(args.p_created_by, USER_ID);
  assert.equal(args.p_provenance, "card_verified");
  assert.equal(args.p_self_service, false);
  assert.equal(args.p_aadhaar_duplicate_override, false);
  assert.equal(args.p_likely_duplicate_override, false);
  assert.equal(typeof args.p_duplicate_key, "string");
  assert.equal(args.p_duplicate_key.length, 64);
});

test("ignores forged creator, duplicate key, and override fields", async () => {
  signIn();
  let args;
  __setServiceRoleClient({
    rpc(_fn, nextArgs) {
      args = nextArgs;
      return Promise.resolve({ data: [{ id: "ok", reg_no: 72 }], error: null });
    },
  });

  await POST(
    request(
      validBody({
        createdBy: "attacker",
        duplicateKey: "chosen-key",
        aadhaarDuplicateOverride: true,
        likelyDuplicateOverride: true,
      }),
    ),
  );

  assert.equal(args.p_created_by, USER_ID);
  assert.notEqual(args.p_duplicate_key, "chosen-key");
  assert.equal(args.p_aadhaar_duplicate_override, false);
  assert.equal(args.p_likely_duplicate_override, false);
});

test("rejects unauthenticated, non-staff, incomplete, and oversized requests", async () => {
  let response = await POST(request(validBody()));
  assert.equal(response.status, 401);

  signIn("doctor");
  response = await POST(request(validBody()));
  assert.equal(response.status, 403);

  signIn();
  response = await POST(request(validBody({ dateOfBirth: "" })));
  assert.equal(response.status, 400);

  response = await POST(request(`{"padding":"${"x".repeat(17_000)}"}`));
  assert.equal(response.status, 400);
});
