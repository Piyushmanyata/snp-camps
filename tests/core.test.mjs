import assert from "node:assert/strict";
import test from "node:test";
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
  resolveOrigin,
} from "../src/lib/qr.ts";
import {
  generatePatientPassword,
  generateStaffPassword,
} from "../src/lib/patient-password.ts";
import { checkRateLimit } from "../src/lib/rate-limit-core.ts";
import { normalizePhoneE164 } from "../src/lib/phone.ts";
import { sensitiveProviderUrl } from "../src/lib/provider-url.ts";
import { isSuccessfulAssignment } from "../src/lib/queue-assignment.ts";
import { queueLabel, queueTone } from "../src/lib/types.ts";
import {
  canRegisterPatients,
  isAdmin,
  isCampCrew,
  isDoctor,
  isStaff,
  roleHome,
} from "../src/lib/roles.ts";
import { validateSupabaseProjectUrl } from "../scripts/bootstrap-admin.mjs";

const VALID_UUID = "e3b0c442-98fc-41c4-a012-3456789abcde";
const VALID_UUID_UPPER = "E3B0C442-98FC-41C4-A012-3456789ABCDE";

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
  assert.equal(
    parsePatientIdFromQr("https://camp.example/checkin?checkin=" + id),
    normalized,
  );
  assert.equal(parsePatientIdFromQr("snp:" + id), normalized);
  assert.equal(parsePatientIdFromQr("SNP:" + id), normalized);
  assert.equal(parsePatientIdFromQr(`  ${id}  `), normalized);
  assert.equal(parsePatientIdFromQr("javascript:alert(1)"), null);
  assert.equal(parsePatientIdFromQr("/patient/enter/not-a-uuid"), null);
  assert.equal(parsePatientIdFromQr(""), null);
  assert.equal(parsePatientIdFromQr("e3b0c44298fc41c4a0123456789abcde"), null);
});

test("QR parser handles noisy camera reads and length bounds", () => {
  assert.equal(
    parsePatientIdFromQr(`SCANNED_PREFIX_${VALID_UUID}_SUFFIX_NOISE`),
    VALID_UUID,
  );
  // Fallback substring search only applies when total length <= 200.
  const longNoisy = "A".repeat(170) + VALID_UUID + "B".repeat(50);
  assert.equal(parsePatientIdFromQr(longNoisy), null);
  assert.equal(parsePatientIdFromQr("a".repeat(513)), null);
});

test("isPatientUuid and resolveOrigin validate inputs", () => {
  assert.equal(isPatientUuid(VALID_UUID), true);
  assert.equal(isPatientUuid(VALID_UUID_UPPER), true);
  assert.equal(isPatientUuid("not-a-uuid"), false);
  assert.equal(resolveOrigin("https://camp.example/"), "https://camp.example");
  assert.equal(resolveOrigin("https://camp.example"), "https://camp.example");
  assert.equal(resolveOrigin(null), "");
});

test("Staff excludes doctor; Camp crew includes all three desk roles", () => {
  for (const role of ["admin", "volunteer"]) {
    assert.equal(isStaff(role), true, `isStaff(${role})`);
    assert.equal(isCampCrew(role), true, `isCampCrew(${role})`);
    assert.equal(canRegisterPatients(role), true);
  }
  assert.equal(isStaff("doctor"), false);
  assert.equal(canRegisterPatients("doctor"), false);
  assert.equal(isCampCrew("doctor"), true);
  assert.equal(isDoctor("doctor"), true);
  assert.equal(isAdmin("admin"), true);
  assert.equal(isAdmin("volunteer"), false);

  assert.equal(isStaff("patient"), false);
  assert.equal(isCampCrew("patient"), false);
  assert.equal(isStaff(null), false);
  assert.equal(isCampCrew(undefined), false);

  assert.equal(roleHome("doctor"), "/doctor");
  assert.equal(roleHome("volunteer"), "/volunteer");
  assert.equal(roleHome("admin"), "/admin");
  assert.equal(roleHome("patient"), "/patient");
});

test("registration number parser rejects overflow and malformed values", () => {
  assert.equal(parseRegistrationNumber("Reg #1001"), 1001);
  assert.equal(parseRegistrationNumber("00042"), 42);
  assert.equal(parseRegistrationNumber(1), 1);
  assert.equal(parseRegistrationNumber(2_147_483_647), 2_147_483_647);
  assert.equal(parseRegistrationNumber("2147483648"), null);
  assert.equal(parseRegistrationNumber(2_147_483_648), null);
  assert.equal(parseRegistrationNumber(Number.POSITIVE_INFINITY), null);
  assert.equal(parseRegistrationNumber(0), null);
  assert.equal(parseRegistrationNumber(-10), null);
  assert.equal(parseRegistrationNumber("not a number"), null);
  assert.equal(parseRegistrationNumber(null), null);
  assert.equal(parseRegistrationNumber(undefined), null);
});

test("patient URLs are staff-scan canonical and passwords avoid ambiguous characters", () => {
  const id = "a0b1c2d3-e4f5-4678-9abc-def012345678";
  assert.equal(patientScanUrl(id, "https://camp.example/"), "snp:" + id);
  assert.equal(
    patientPrintUrl(id, "https://camp.example/"),
    "https://camp.example/print/" + id,
  );
  assert.equal(patientScanUrl(id, ""), "snp:" + id);
  assert.equal(patientScanUrl("invalid-id", "https://camp.example"), "invalid-id");

  const generated = new Set(
    Array.from({ length: 20 }, () => generatePatientPassword(12)),
  );
  assert.equal(generated.size, 20);
  for (const password of generated) {
    assert.match(password, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/);
  }
  assert.match(
    generatePatientPassword(),
    /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/,
  );
  assert.match(
    generateStaffPassword(),
    /^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789]{14}$/,
  );
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

test("rate limits enforce both client IP and supplied subject", () => {
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

test("rate limits block IP burst and subject rotation independently", () => {
  const reqBase = "https://camp.example/api/test";
  const scopeIp = "test-ip-burst-" + Math.random();
  for (let i = 1; i <= 6; i += 1) {
    const req = new Request(reqBase, {
      headers: { "x-forwarded-for": "10.0.0.1" },
    });
    const res = checkRateLimit(req, {
      scope: scopeIp,
      limit: 5,
      windowMs: 60_000,
    });
    assert.equal(res.allowed, i <= 5, `IP request ${i}`);
  }

  const scopeSubject = "test-subject-rot-" + Math.random();
  const subject = "patient-uuid-target";
  for (let i = 1; i <= 5; i += 1) {
    const req = new Request(reqBase, {
      headers: { "x-forwarded-for": `192.168.1.${i}` },
    });
    const res = checkRateLimit(req, {
      scope: scopeSubject,
      identifier: subject,
      limit: 3,
      windowMs: 60_000,
    });
    assert.equal(res.allowed, i <= 3, `subject request ${i}`);
  }
});

test("notification phone normalization accepts common Indian formats", () => {
  assert.equal(normalizePhoneE164("9876543210"), "+919876543210");
  assert.equal(normalizePhoneE164("09876543210"), "+919876543210");
  assert.equal(normalizePhoneE164("+91 98765 43210"), "+919876543210");
  assert.equal(normalizePhoneE164("0919876543210"), "+919876543210");
  assert.equal(normalizePhoneE164("919876543210"), "+919876543210");
  assert.equal(normalizePhoneE164("12345"), null);
  assert.equal(normalizePhoneE164("1234567890"), null);
  assert.equal(normalizePhoneE164(""), null);
});

test("only a completed, error-free doctor assignment is successful", () => {
  const completed = {
    already_seen: false,
    doctor_id: "00000000-0000-4000-8000-000000000001",
    error_code: null,
    queue_status: "seen",
  };

  assert.equal(isSuccessfulAssignment(completed), true);
  assert.equal(
    isSuccessfulAssignment({ ...completed, error_code: "unexpected" }),
    false,
  );
  assert.equal(
    isSuccessfulAssignment({ ...completed, queue_status: "waiting" }),
    false,
  );
  assert.equal(isSuccessfulAssignment({ ...completed, doctor_id: null }), false);
  assert.equal(
    isSuccessfulAssignment({ ...completed, already_seen: true }),
    false,
  );
});

test("queue labels and tones map known statuses", () => {
  assert.equal(queueLabel("seen"), "Doctor seen");
  assert.equal(queueLabel("waiting"), "In queue");
  assert.equal(queueLabel("registered"), "Registered");
  assert.equal(queueTone("seen"), "ok");
  assert.equal(queueTone("waiting"), "wait");
  assert.equal(queueTone("registered"), "default");
});
