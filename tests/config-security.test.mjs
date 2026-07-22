import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const config = fs.readFileSync(
  path.join(process.cwd(), "next.config.ts"),
  "utf8",
);
const layout = fs.readFileSync(
  path.join(process.cwd(), "src/app/layout.tsx"),
  "utf8",
);
const auth = fs.readFileSync(
  path.join(process.cwd(), "src/lib/auth.ts"),
  "utf8",
);
const health = fs.readFileSync(
  path.join(process.cwd(), "src/app/api/health/route.ts"),
  "utf8",
);

test("CSP follows the configured Supabase protocol without production eval", () => {
  assert.match(config, /configuredSupabaseUrl\?\.origin/);
  assert.match(config, /protocol === "http:" \? "ws:" : "wss:"/);
  assert.match(config, /process\.env\.NODE_ENV === "development"/);
  assert.match(config, /: "script-src 'self' 'unsafe-inline'"/);
});

test("preconnect follows the configured project and smooth scrolling is declared", () => {
  assert.match(layout, /new URL\(process\.env\.NEXT_PUBLIC_SUPABASE_URL\)\.origin/);
  assert.match(layout, /href=\{supabaseOrigin\}/);
  assert.doesNotMatch(layout, /ruklmrzpyutvefancsgo/);
  assert.match(layout, /data-scroll-behavior="smooth"/);
});

test("authenticated requests reuse verified JWT claims and JSON mutations reject simple-form CSRF", () => {
  assert.match(auth, /supabase\.auth\.getClaims\(\)/);
  assert.doesNotMatch(auth, /supabase\.auth\.getUser\(\)/);
  assert.match(auth, /mediaType !== "application\/json"/);
  assert.match(auth, /total > maxBytes/);
});

test("readiness checks the required phone OTP provider, not optional Aadhaar", () => {
  assert.match(health, /auth\/v1\/settings/);
  assert.match(health, /external\?\.phone === true/);
  assert.match(health, /Boolean\(settings\.sms_provider\)/);
  assert.doesNotMatch(health, /AADHAAR_VERIFY|registration_verifications|register_verified_patient/);
});
