import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import {
  aadhaarLast4,
  digitsOnly,
  formatAadhaarDisplay,
  isValidAadhaarNumber,
  normalizeGender,
} from "../src/lib/aadhaar.ts";
import {
  isPatientUuid,
  parseRegistrationNumber,
  parsePatientIdFromQr,
  patientPrintUrl,
  patientScanUrl,
} from "../src/lib/qr.ts";
import { generatePatientPassword } from "../src/lib/patient-password.ts";
import { checkRateLimit } from "../src/lib/rate-limit-core.ts";
import { normalizePhoneE164 } from "../src/lib/phone.ts";
import { sensitiveProviderUrl } from "../src/lib/provider-url.ts";
import { validateSupabaseProjectUrl } from "../scripts/bootstrap-admin.mjs";

test("Aadhaar helpers normalize without retaining extra digits", () => {
  assert.equal(digitsOnly("9999 9999-0019"), "999999990019");
  assert.equal(formatAadhaarDisplay("99999999001988"), "9999 9999 0019");
  assert.equal(aadhaarLast4("9999 9999 0019"), "0019");
});

test("Aadhaar checksum rejects malformed and repeated values", () => {
  assert.equal(isValidAadhaarNumber("9999 9999 0019"), true);
  assert.equal(isValidAadhaarNumber("9999 9999 0018"), false);
  assert.equal(isValidAadhaarNumber("1111 1111 1111"), false);
  assert.equal(isValidAadhaarNumber("123"), false);
});

test("gender normalization accepts common provider values", () => {
  assert.equal(normalizeGender("female"), "F");
  assert.equal(normalizeGender("MALE"), "M");
  assert.equal(normalizeGender("T"), "O");
  assert.equal(normalizeGender("unknown"), null);
});

test("QR parser accepts staff-scan identifiers only", () => {
  const id = "A0B1C2D3-E4F5-4678-9ABC-DEF012345678";
  const normalized = id.toLowerCase();
  assert.equal(isPatientUuid(id), true);
  assert.equal(parsePatientIdFromQr(id), normalized);
  assert.equal(
    parsePatientIdFromQr("https://camp.example/p/" + id),
    normalized,
  );
  assert.equal(
    parsePatientIdFromQr("https://camp.example/patient/enter/" + id + "?t=x"),
    normalized,
  );
  assert.equal(
    parsePatientIdFromQr("https://camp.example/print/" + id),
    normalized,
  );
  assert.equal(
    parsePatientIdFromQr("https://camp.example/anything?id=" + id),
    normalized,
  );
  assert.equal(
    parsePatientIdFromQr("https://camp.example/doctor?scan=" + id),
    normalized,
  );
  assert.equal(parsePatientIdFromQr("snp:" + id), normalized);
  assert.equal(parsePatientIdFromQr("javascript:alert(1)"), null);
  assert.equal(parsePatientIdFromQr("/patient/enter/not-a-uuid"), null);
});

test("registration number parser rejects overflow and malformed values", () => {
  assert.equal(parseRegistrationNumber("Reg #1001"), 1001);
  assert.equal(parseRegistrationNumber(2_147_483_647), 2_147_483_647);
  assert.equal(parseRegistrationNumber("2147483648"), null);
  assert.equal(parseRegistrationNumber(Number.POSITIVE_INFINITY), null);
  assert.equal(parseRegistrationNumber("not a number"), null);
});

test("patient URLs are staff-scan canonical and passwords avoid ambiguous characters", () => {
  const id = "a0b1c2d3-e4f5-4678-9abc-def012345678";
  assert.equal(patientScanUrl(id, "https://camp.example/"), "snp:" + id);
  assert.equal(
    patientPrintUrl(id, "https://camp.example/"),
    "https://camp.example/print/" + id,
  );
  // Compact snp: payload (denser paper QR) regardless of origin
  assert.equal(patientScanUrl(id, ""), "snp:" + id);

  const generated = new Set(
    Array.from({ length: 20 }, () => generatePatientPassword(12)),
  );
  assert.equal(generated.size, 20);
  for (const password of generated) {
    assert.match(password, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/);
  }
  assert.match(generatePatientPassword(), /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/);
});

test("sensitive provider URLs require a secure transport", () => {
  assert.equal(
    sensitiveProviderUrl("https://identity.example/verify"),
    "https://identity.example/verify",
  );
  assert.equal(sensitiveProviderUrl("http://identity.example/verify"), null);
  assert.equal(sensitiveProviderUrl("file:///etc/passwd"), null);
  assert.equal(sensitiveProviderUrl("not a URL"), null);
});

test("admin bootstrap sends its service key only to the exact Supabase project", () => {
  const ref = "abcdefghijklmnopqrst";
  const exact = `https://${ref}.supabase.co`;
  assert.equal(validateSupabaseProjectUrl(exact, ref), `${exact}/`);

  for (const hostile of [
    `https://${ref}.evil.example`,
    `https://${ref}.supabase.co.evil.example`,
    `https://user:password@${ref}.supabase.co`,
    `https://${ref}.supabase.co:444`,
    `https://${ref}.supabase.co/rest/v1`,
    `https://${ref}.supabase.co?redirect=evil`,
    `http://${ref}.supabase.co`,
  ]) {
    assert.throws(() => validateSupabaseProjectUrl(hostile, ref));
  }
});

test("rate limits enforce both client and supplied subject", () => {
  const request = new Request("https://camp.example/api", {
    headers: { "x-forwarded-for": "198.51.100.10" },
  });
  const options = {
    scope: "test-subject-limit-" + Math.random(),
    identifier: "patient-123",
    limit: 2,
    windowMs: 60_000,
  };
  assert.equal(checkRateLimit(request, options).allowed, true);
  assert.equal(checkRateLimit(request, options).allowed, true);
  assert.equal(checkRateLimit(request, options).allowed, false);

  const rotatedIp = new Request("https://camp.example/api", {
    headers: { "x-forwarded-for": "198.51.100.11" },
  });
  assert.equal(checkRateLimit(rotatedIp, options).allowed, false);
});

test("notification phone normalization accepts common Indian formats", () => {
  assert.equal(normalizePhoneE164("9876543210"), "+919876543210");
  assert.equal(normalizePhoneE164("09876543210"), "+919876543210");
  assert.equal(normalizePhoneE164("+91 98765 43210"), "+919876543210");
  assert.equal(normalizePhoneE164("0919876543210"), "+919876543210");
  assert.equal(normalizePhoneE164("919876543210"), "+919876543210");
  assert.equal(normalizePhoneE164("12345"), null);
  assert.equal(normalizePhoneE164("1234567890"), null);
});

test("R1: PatientForm userRole='admin' generates href='/admin' with text 'Back to admin'", () => {
  const componentPath = path.join(process.cwd(), "src/components/patient-form.tsx");
  const content = fs.readFileSync(componentPath, "utf-8");

  assert.ok(content.includes('userRole === "admin"'), "PatientForm must check userRole === 'admin'");
  assert.ok(content.includes('? "/admin"'), "PatientForm must set href to '/admin' for admin role");
  assert.ok(content.includes('? "Back to admin"'), "PatientForm must display label 'Back to admin' for admin role");
});

test("R2: SQL migration 20260721000000_volunteer_checked_in_kpi.sql correctly aggregates created_by OR checked_in_by", () => {
  const sqlPath = path.join(process.cwd(), "supabase/migrations/20260721000000_volunteer_checked_in_kpi.sql");
  const sqlContent = fs.readFileSync(sqlPath, "utf-8");

  assert.ok(
    sqlContent.includes("ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS checked_in_by uuid"),
    "Migration must add checked_in_by column"
  );
  assert.ok(
    sqlContent.includes("checked_in_by = coalesce(checked_in_by, auth.uid())"),
    "RPCs must set checked_in_by with fallback to auth.uid()"
  );
  assert.ok(
    sqlContent.includes("(p.created_by = auth.uid() or p.checked_in_by = auth.uid())"),
    "volunteer_my_counts must filter on created_by OR checked_in_by"
  );
  assert.ok(
    sqlContent.includes("(p.created_by = p_user_id or p.checked_in_by = p_user_id)"),
    "staff_person_kpis must filter on created_by OR checked_in_by for volunteers"
  );
});
