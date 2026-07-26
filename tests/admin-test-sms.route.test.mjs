/**
 * Admin test-SMS API (#51).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { GET, POST } from "../src/app/api/admin/test-sms/route.ts";
import {
  __resetAuthMock,
  __setAuthMock,
} from "./stubs/supabase-ssr.mjs";
import { __resetCookies } from "./stubs/next-headers.mjs";
import { resetSmsFailuresForTests } from "../src/lib/registration-sms.ts";

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function sessionAsAdmin() {
  __resetCookies([{ name: "sb-test-auth-token", value: "1" }]);
  __setAuthMock({
    userId: ADMIN_ID,
    profile: {
      id: ADMIN_ID,
      role: "admin",
      full_name: "Admin",
      phone: null,
      email: "admin@test.local",
      disabled_at: null,
    },
  });
}

test("GET test-sms requires admin and reports configuration", async () => {
  __resetAuthMock();
  __resetCookies([]);
  resetSmsFailuresForTests();
  const denied = await GET();
  assert.equal(denied.status, 401);

  sessionAsAdmin();
  delete process.env.MSG91_AUTH_KEY;
  delete process.env.MSG91_SENDER_ID;
  delete process.env.MSG91_TEMPLATE_REGISTRATION;
  // Session stub may lack rpc — route falls back to empty durable failures.
  const res = await GET();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.configured, false);
  assert.ok(Array.isArray(body.failures));
  assert.ok(body.sampleMaxLengthChars <= 160);
});

test("POST test-sms rejects unconfigured provider", async () => {
  sessionAsAdmin();
  delete process.env.MSG91_AUTH_KEY;
  delete process.env.MSG91_SENDER_ID;
  delete process.env.MSG91_TEMPLATE_REGISTRATION;
  const res = await POST(
    new Request("http://local/api/admin/test-sms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "9876543210" }),
    }),
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.status, "skipped");
});
