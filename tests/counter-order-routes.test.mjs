import assert from "node:assert/strict";
import test from "node:test";
import { POST as createOrder } from "../src/app/api/counter/create-order/route.ts";
import { POST as resolveOrder } from "../src/app/api/counter/resolve-order/route.ts";
import { __resetCookies, __setCookies } from "./stubs/next-headers.mjs";
import {
  __resetAuthMock,
  __setAuthMock,
} from "./stubs/supabase-ssr.mjs";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const PATIENT_ID = "22222222-2222-4222-8222-222222222222";
const ORDER_ID = "33333333-3333-4333-8333-333333333333";

function request(path, body, contentType = "application/json") {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function signIn(role = "volunteer", rpc) {
  __setCookies([{ name: "sb-test-auth-token", value: "session" }]);
  __setAuthMock({
    userId: USER_ID,
    profile: {
      id: USER_ID,
      role,
      full_name: "Counter User",
      disabled_at: null,
    },
    rpc,
  });
}

test.beforeEach(() => {
  __resetCookies();
  __resetAuthMock();
});

test("counter create route authenticates, normalizes, and deduplicates kinds", async () => {
  let call;
  signIn("team_lead", async (fn, args) => {
    call = { fn, args };
    return { data: [{ created_count: 2 }], error: null };
  });

  const response = await createOrder(
    request("/api/counter/create-order", {
      patientId: PATIENT_ID,
      kinds: [" Spectacles ", "spectacles", "PHARMACY"],
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(call, {
    fn: "counter_create_and_fulfill_order",
    args: {
      p_patient_id: PATIENT_ID,
      p_kinds: ["spectacles", "pharmacy"],
    },
  });
});

test("counter create route rejects unauthenticated, invalid, and oversized input", async () => {
  let response = await createOrder(
    request("/api/counter/create-order", {
      patientId: PATIENT_ID,
      kinds: ["pharmacy"],
    }),
  );
  assert.equal(response.status, 403);

  signIn();
  response = await createOrder(
    request("/api/counter/create-order", {
      patientId: "not-a-uuid",
      kinds: ["pharmacy"],
    }),
  );
  assert.equal(response.status, 400);

  response = await createOrder(
    request("/api/counter/create-order", {
      patientId: PATIENT_ID,
      kinds: ["invalid"],
    }),
  );
  assert.equal(response.status, 400);

  response = await createOrder(
    request(
      "/api/counter/create-order",
      `{"padding":"${"x".repeat(3_000)}"}`,
    ),
  );
  assert.equal(response.status, 400);
});

test("counter resolve route validates identifiers and bounded defer metadata", async () => {
  const calls = [];
  signIn("doctor", async (fn, args) => {
    calls.push({ fn, args });
    return { data: [{ id: ORDER_ID }], error: null };
  });

  let response = await resolveOrder(
    request("/api/counter/resolve-order", {
      orderId: ORDER_ID,
      action: "deferred",
      deferredDate: "2026-10-15",
      deferredVenue: "  Civil Hospital  ",
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(calls[0].args.p_deferred_venue, "Civil Hospital");

  response = await resolveOrder(
    request("/api/counter/resolve-order", {
      orderId: "bad",
      action: "fulfilled",
    }),
  );
  assert.equal(response.status, 400);

  response = await resolveOrder(
    request("/api/counter/resolve-order", {
      orderId: ORDER_ID,
      action: "deferred",
      deferredDate: "15-10-2026",
    }),
  );
  assert.equal(response.status, 400);

  response = await resolveOrder(
    request("/api/counter/resolve-order", {
      orderId: ORDER_ID,
      action: "deferred",
      deferredDate: "2026-10-15",
      deferredVenue: "x".repeat(161),
    }),
  );
  assert.equal(response.status, 400);
});
