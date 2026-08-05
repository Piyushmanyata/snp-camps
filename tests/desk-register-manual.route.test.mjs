import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../src/app/api/desk/register-manual/route.ts";
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
    reason: "QR unreadable after three tries",
    failedScanAttempts: 3,
    ...overrides,
  };
}

function request(body) {
  return new Request("http://localhost/api/desk/register-manual", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function signIn(role = "team_lead") {
  __setCookies([{ name: "sb-test-auth-token", value: "session" }]);
  __setAuthMock({
    userId: USER_ID,
    profile: {
      id: USER_ID,
      role,
      full_name: "Lead",
      disabled_at: null,
    },
  });
}

test.beforeEach(() => {
  __resetCookies();
  __resetAuthMock();
  __resetServiceRoleClient();
});

test("rejects non-UUID campDayId without calling RPC", async () => {
  signIn();
  let rpcCalls = 0;
  __setServiceRoleClient({
    rpc() {
      rpcCalls += 1;
      return Promise.resolve({ data: null, error: null });
    },
  });
  const res = await POST(request(validBody({ campDayId: "not-a-uuid" })));
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.match(body.error.message, /Registration session is invalid/);
  assert.equal(rpcCalls, 0);
});

test("rejects invalid gender without calling RPC", async () => {
  signIn();
  let rpcCalls = 0;
  __setServiceRoleClient({
    rpc() {
      rpcCalls += 1;
      return Promise.resolve({ data: null, error: null });
    },
  });
  const res = await POST(request(validBody({ gender: "X" })));
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.match(body.error.message, /Registration session is invalid/);
  assert.equal(rpcCalls, 0);
});

test("rejects age 200 without calling RPC", async () => {
  signIn();
  let rpcCalls = 0;
  __setServiceRoleClient({
    rpc() {
      rpcCalls += 1;
      return Promise.resolve({ data: null, error: null });
    },
  });
  const res = await POST(request(validBody({ age: 200 })));
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.match(body.error.message, /Registration session is invalid/);
  assert.equal(rpcCalls, 0);
});
