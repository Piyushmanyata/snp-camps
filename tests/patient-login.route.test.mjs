/**
 * Behavioural coverage for POST /api/patient-login.
 * Imports the route handler with mocked Supabase (tests/route-loader.mjs).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../src/app/api/patient-login/route.ts";
import {
  __resetAuthMock,
  __setAuthMock,
} from "./stubs/supabase-ssr.mjs";

function clearRateLimits() {
  globalThis.__snpRateLimits?.clear();
}

function loginRequest(body, ip = "203.0.113.10") {
  return new Request("http://127.0.0.1/api/patient-login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify(body),
  });
}

test.beforeEach(() => {
  clearRateLimits();
  __resetAuthMock();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
});

test("successful sign-in body has exactly ok and regNo", async () => {
  __setAuthMock({
    signInWithPassword: async () => ({
      data: { user: { id: "user-1" } },
      error: null,
    }),
    profile: { role: "patient", disabled_at: null },
  });

  const res = await POST(
    loginRequest({ regNo: 42, passcode: "GOODPASSCODE1" }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ["ok", "regNo"]);
  assert.equal(body.ok, true);
  assert.equal(body.regNo, 42);
  assert.equal("password" in body, false);
  assert.equal("passcode" in body, false);
  assert.equal("email" in body, false);
});

test("wrong reg and wrong passcode return the same status and message", async () => {
  __setAuthMock({
    signInWithPassword: async () => ({
      data: { user: null },
      error: { message: "Invalid login credentials" },
    }),
  });

  const wrongReg = await POST(
    loginRequest({ regNo: "not-a-reg", passcode: "ANYTHING1" }, "203.0.113.20"),
  );
  const wrongPass = await POST(
    loginRequest({ regNo: 1001, passcode: "WRONGPASSCODE" }, "203.0.113.21"),
  );

  const regBody = await wrongReg.json();
  const passBody = await wrongPass.json();

  assert.equal(wrongReg.status, wrongPass.status);
  assert.equal(regBody.error, passBody.error);
  assert.equal(wrongReg.status, 401);
  assert.match(String(regBody.error), /registration number or passcode/i);
});

test("thirteen login attempts inside the window return 429", async () => {
  __setAuthMock({
    signInWithPassword: async () => ({
      data: { user: null },
      error: { message: "Invalid login credentials" },
    }),
  });

  const ip = "203.0.113.30";
  const statuses = [];
  for (let i = 0; i < 13; i++) {
    const res = await POST(
      loginRequest({ regNo: 77, passcode: "ATTEMPTPASS1" }, ip),
    );
    statuses.push(res.status);
  }

  assert.equal(statuses.length, 13);
  assert.ok(
    statuses.slice(0, 12).every((s) => s === 401),
    `first twelve should be 401, got ${statuses.slice(0, 12)}`,
  );
  assert.equal(statuses[12], 429);
});
