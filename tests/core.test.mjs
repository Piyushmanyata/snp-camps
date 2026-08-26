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
  isStaffPasswordStrong,
  MIN_PASSWORD_LENGTH,
} from "../src/lib/staff-password.ts";
import { generateStaffPassword } from "../src/lib/staff-password-generate.ts";
import { checkRateLimit } from "../src/lib/rate-limit-core.ts";
import { normalizePhoneE164 } from "../src/lib/phone.ts";
import {
  derivedAgeYears,
  isIsoCalendarDate,
  validateRegistrationIdentity,
  validateRegistrationIds,
} from "../src/lib/registration-input.ts";
import { genderLabel, queueLabel, queueTone } from "../src/lib/types.ts";
import {
  canRegisterPatients,
  isAdmin,
  isCampCrew,
  isStaff,
  isTeamLead,
  roleHome,
} from "../src/lib/roles.ts";
import {
  buildContentSecurityPolicy,
  productionScriptSrcAllowsUnsafeInline,
} from "../src/lib/csp.ts";
import { validateSupabaseProjectUrl } from "../scripts/bootstrap-admin.mjs";
import {
  DEFAULT_PRESCRIPTION_TEMPLATE,
  resolvePrescriptionTemplate,
} from "../src/lib/prescription-template.ts";

const VALID_UUID = "e3b0c442-98fc-41c4-a012-3456789abcde";
const VALID_UUID_UPPER = "E3B0C442-98FC-41C4-A012-3456789ABCDE";

test("prescription template bounds dynamic content to one-page-safe limits", () => {
  const template = resolvePrescriptionTemplate({
    diagnosisOptions: Array.from({ length: 20 }, (_, i) => `Diagnosis ${i}`),
    vitalsFields: Array.from({ length: 20 }, (_, i) => `Vital ${i}`),
    sections: Array.from({ length: 10 }, (_, i) => ({
      key: `section-${i}`,
      label: `Section ${i}`,
      heightMm: 120,
    })),
    footerNote: "x".repeat(1000),
  });

  assert.equal(template.diagnosisOptions.length, 6);
  assert.equal(template.vitalsFields.length, 4);
  assert.ok(template.sections.length <= 4);
  assert.ok(
    template.sections.reduce((sum, section) => sum + section.heightMm, 0) <= 42,
  );
  assert.equal(template.footerNote.length, 180);
  assert.equal(
    resolvePrescriptionTemplate(null),
    DEFAULT_PRESCRIPTION_TEMPLATE,
  );
});

test("prescription template preserves the built-in and uploaded sponsor order", () => {
  const first = "/api/admin/sponsor-assets/11111111-1111-4111-8111-111111111111";
  const second = "/api/admin/sponsor-assets/22222222-2222-4222-8222-222222222222";

  assert.deepEqual(
    resolvePrescriptionTemplate({
      sponsorLogos: ["/brand/rupa-logo.png", first, second],
    }).sponsorLogos,
    ["/brand/rupa-logo.png", first, second],
  );
});

test("hidden sections do not consume the visible height budget", () => {
  const template = resolvePrescriptionTemplate({
    sections: [
      { key: "hidden", label: "Hidden", heightMm: 32, visible: false },
      { key: "visible", label: "Visible", heightMm: 26, visible: true },
    ],
  });
  assert.deepEqual(template.sections, [
    { key: "hidden", label: "Hidden", heightMm: 32, visible: false },
    { key: "visible", label: "Visible", heightMm: 26, visible: true },
  ]);
});

test("visible sections are clamped only after the remaining budget is used", () => {
  const template = resolvePrescriptionTemplate({
    sections: [
      { key: "first", label: "First", heightMm: 32, visible: true },
      { key: "second", label: "Second", heightMm: 26, visible: true },
    ],
  });
  assert.deepEqual(template.sections, [
    { key: "first", label: "First", heightMm: 32, visible: true },
    { key: "second", label: "Second", heightMm: 10, visible: true },
  ]);
});

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
    parsePatientIdFromQr("https://camp.example/scan?value=" + id),
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

test("staff and camp crew are the same set once the doctor role is retired (D21)", () => {
  for (const role of ["admin", "team_lead", "volunteer"]) {
    assert.equal(isStaff(role), true, `isStaff(${role})`);
    assert.equal(isCampCrew(role), true, `isCampCrew(${role})`);
    assert.equal(canRegisterPatients(role), true);
  }
  assert.equal(isAdmin("admin"), true);
  assert.equal(isAdmin("volunteer"), false);

  // Residual/legacy role strings must never grant a desk or a home (#59, D21).
  for (const legacy of ["doctor", "patient"]) {
    assert.equal(isStaff(/** @type {any} */ (legacy)), false, `isStaff(${legacy})`);
    assert.equal(
      isCampCrew(/** @type {any} */ (legacy)),
      false,
      `isCampCrew(${legacy})`,
    );
    assert.equal(canRegisterPatients(/** @type {any} */ (legacy)), false);
    assert.equal(roleHome(/** @type {any} */ (legacy)), null, `roleHome(${legacy})`);
  }
  assert.equal(isStaff(null), false);
  assert.equal(isCampCrew(undefined), false);

  assert.equal(roleHome("volunteer"), "/volunteer");
  assert.equal(roleHome("team_lead"), "/volunteer");
  assert.equal(roleHome("admin"), "/admin");
});

test("CSP script-src keeps self and nonce without unsafe-inline or strict-dynamic", () => {
  const prod = buildContentSecurityPolicy("testnonce", { isDev: false });
  assert.equal(productionScriptSrcAllowsUnsafeInline(prod), false);
  assert.match(prod, /nonce-testnonce/);
  const prodScript = prod
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("script-src"));
  assert.ok(prodScript);
  assert.match(prodScript, /'self'/);
  assert.doesNotMatch(prodScript, /'unsafe-inline'/);
  // Narrow WASM grant only — the bare 'unsafe-eval' must stay out of production.
  // The Aadhaar scanner cannot instantiate ZXing/ZBar/OpenCV without this, and
  // its absence fails in production only, since dev carries 'unsafe-eval'.
  assert.match(prodScript, /'wasm-unsafe-eval'/);
  assert.doesNotMatch(prodScript, /'unsafe-eval'/);
  assert.doesNotMatch(prodScript, /'strict-dynamic'/);

  const dev = buildContentSecurityPolicy("devnonce", { isDev: true });
  const devScript = dev
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("script-src"));
  assert.ok(devScript);
  assert.match(devScript, /'self'/);
  assert.match(devScript, /nonce-devnonce/);
  assert.match(devScript, /'unsafe-eval'/);
  assert.doesNotMatch(devScript, /'unsafe-inline'/);
  assert.doesNotMatch(devScript, /'strict-dynamic'/);
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

test("password policy matches Supabase Auth minimum and composition rules", () => {
  assert.equal(MIN_PASSWORD_LENGTH, 12);
  assert.equal(isStaffPasswordStrong("a".repeat(12)), false);
  assert.equal(isStaffPasswordStrong("Aa2!" + "a".repeat(8)), true);
  assert.equal(isStaffPasswordStrong(""), false);
});

test("registration validation shares strict IDs, dates, identity bounds, and age rules", () => {
  const ids = validateRegistrationIds({
    requestId: VALID_UUID,
    campId: VALID_UUID_UPPER,
    campDayId: VALID_UUID,
  });
  assert.equal(ids.ok, true);
  assert.equal(
    validateRegistrationIds({ requestId: "", campId: VALID_UUID, campDayId: VALID_UUID }).ok,
    false,
  );
  assert.equal(isIsoCalendarDate("2024-02-29"), true);
  assert.equal(isIsoCalendarDate("2023-02-29"), false);
  assert.equal(isIsoCalendarDate("2999-01-01"), false);
  const istMidnight = new Date("2026-08-15T18:30:00.000Z");
  const istBeforeDawn = new Date("2026-08-15T23:59:00.000Z");
  assert.equal(isIsoCalendarDate("2026-08-16", istMidnight), true);
  assert.equal(isIsoCalendarDate("2026-08-16", istBeforeDawn), true);
  assert.equal(isIsoCalendarDate("2026-08-17", istMidnight), false);
  assert.equal(derivedAgeYears("2000-08-16", istMidnight), 26);
  assert.equal(derivedAgeYears("2000-08-17", istMidnight), 25);
  assert.equal(derivedAgeYears("2024-02-29", new Date("2025-02-28T18:30:00.000Z")), 1);
  assert.equal(
    validateRegistrationIdentity({
      fullName: "Ramesh Kumar",
      gender: "M",
      age: 50,
      address: "Sikar",
      dateOfBirth: "1976-05-15",
      selfService: true,
    }).ok,
    true,
  );
  assert.equal(
    validateRegistrationIdentity({
      fullName: "Ramesh Kumar",
      gender: "X",
      age: 200,
      selfService: false,
    }).ok,
    false,
  );
});

test("patient URLs are staff-scan canonical and staff passwords avoid ambiguous characters", () => {
  const id = "a0b1c2d3-e4f5-4678-9abc-def012345678";
  assert.equal(patientScanUrl(id, "https://camp.example/"), "snp:" + id);
  assert.equal(
    patientPrintUrl(id, "https://camp.example/"),
    "https://camp.example/print/" + id,
  );
  assert.equal(patientScanUrl(id, ""), "snp:" + id);
  assert.equal(patientScanUrl("invalid-id", "https://camp.example"), "invalid-id");

  for (let i = 0; i < 200; i += 1) {
    const password = generateStaffPassword();
    assert.equal(password.length, 16);
    assert.equal(isStaffPasswordStrong(password), true);
    assert.doesNotMatch(password, /[ILOilo01]/);
  }
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
    headers: { "x-vercel-forwarded-for": "198.51.100.10" },
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
    headers: { "x-vercel-forwarded-for": "198.51.100.11" },
  });
  assert.equal(checkRateLimit(rotatedIp, options).allowed, false);
});

test("off-Vercel, no forwarding header buys a fresh IP bucket", () => {
  // Off the platform nothing overwrites these headers, so a caller can set any
  // of them per request. Trusting one meant rotating it reset the bucket and
  // the self-registration throttle was decorative.
  const saved = { VERCEL: process.env.VERCEL, VERCEL_ENV: process.env.VERCEL_ENV };
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  try {
    for (const header of [
      "x-forwarded-for",
      "x-vercel-forwarded-for",
      "x-real-ip",
      "cf-connecting-ip",
    ]) {
      const options = {
        scope: `test-untrusted-${header}-` + Math.random(),
        limit: 2,
        windowMs: 60_000,
        keyType: "ip",
      };
      const allowed = [1, 2, 3].map(
        (i) =>
          checkRateLimit(
            new Request("https://camp.example/api", {
              headers: { [header]: `203.0.113.${i}` },
            }),
            options,
          ).allowed,
      );
      assert.deepEqual(
        allowed,
        [true, true, false],
        `rotating ${header} must not reset the bucket`,
      );
    }
  } finally {
    if (saved.VERCEL === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = saved.VERCEL;
    if (saved.VERCEL_ENV === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = saved.VERCEL_ENV;
  }
});

test("rate limits block IP burst and subject rotation independently", () => {
  const reqBase = "https://camp.example/api/test";
  const scopeIp = "test-ip-burst-" + Math.random();
  for (let i = 1; i <= 6; i += 1) {
    const req = new Request(reqBase, {
      headers: { "x-vercel-forwarded-for": "10.0.0.1" },
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
      headers: { "x-vercel-forwarded-for": `192.168.1.${i}` },
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

test("rate-limit scopes can consume IP and subject buckets separately", () => {
  const request = new Request("https://camp.example/api/status", {
    headers: { "x-vercel-forwarded-for": "203.0.113.10" },
  });
  const scope = `separate-status-${Math.random()}`;
  const ip = {
    scope: `${scope}-ip`,
    limit: 2,
    windowMs: 60_000,
    keyType: "ip",
  };
  const subject = {
    scope: `${scope}-subject`,
    identifier: "status-token-1",
    limit: 2,
    windowMs: 60_000,
    keyType: "subject",
  };

  assert.equal(checkRateLimit(request, ip).allowed, true);
  assert.equal(checkRateLimit(request, subject).allowed, true);
  assert.equal(
    checkRateLimit(
      new Request(request, { headers: { "x-vercel-forwarded-for": "203.0.113.11" } }),
      ip,
    ).allowed,
    true,
    "a rotated IP does not bypass the subject-only bucket",
  );
  assert.equal(checkRateLimit(request, subject).allowed, true);
  assert.equal(checkRateLimit(request, subject).allowed, false);
  assert.equal(checkRateLimit(request, ip).allowed, true);
  assert.equal(checkRateLimit(request, ip).allowed, false);
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

test("status labels and tones cover the two-state lifecycle", () => {
  assert.equal(queueLabel("seen"), "Seen");
  assert.equal(queueLabel("registered"), "Registered");
  assert.equal(queueTone("seen"), "ok");
  assert.equal(queueTone("registered"), "default");
  // `waiting` is dead on the enum but not droppable; a residual row must read
  // as Registered, never as a line position (ADR 0013).
  assert.equal(queueLabel("waiting"), "Registered");
  assert.equal(queueTone("waiting"), "default");
});

test("gender never reaches a field surface as a raw M/F/O column", () => {
  assert.equal(genderLabel("M"), "Purush");
  assert.equal(genderLabel("F"), "Mahila");
  assert.equal(genderLabel("O"), "Anya");
  // Unset and unexpected values render as an em dash, never the raw value.
  assert.equal(genderLabel(null), "—");
  assert.equal(genderLabel(undefined), "—");
  assert.equal(genderLabel(""), "—");
  assert.equal(genderLabel("m"), "—");
});

test("team_lead role predicates and roleHome route correctly", () => {
  assert.equal(isStaff("team_lead"), true);
  assert.equal(isCampCrew("team_lead"), true);
  assert.equal(isTeamLead("team_lead"), true);
  assert.equal(isTeamLead("volunteer"), false);
  assert.equal(isAdmin("team_lead"), false);
  assert.equal(canRegisterPatients("team_lead"), true);
  assert.equal(roleHome("team_lead"), "/volunteer");
});
