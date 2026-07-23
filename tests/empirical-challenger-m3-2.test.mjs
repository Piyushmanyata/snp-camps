import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  parseRegistrationNumber,
  parsePatientIdFromQr,
} from "../src/lib/qr.ts";

import {
  digitsOnly,
  formatAadhaarDisplay,
  aadhaarLast4,
  isValidAadhaarNumber,
  normalizeGender,
  ageFromDob,
} from "../src/lib/aadhaar.ts";

import {
  generatePatientPassword,
  generateStaffPassword,
  DEFAULT_PATIENT_PASSWORD,
} from "../src/lib/patient-password.ts";

import { normalizePhoneE164 } from "../src/lib/phone.ts";
import { queueLabel, queueTone, formatCampDay } from "../src/lib/types.ts";

const VALID_UUID = "e3b0c442-98fc-41c4-a012-3456789abcde";
const VALID_UUID_UPPER = "E3B0C442-98FC-41C4-A012-3456789ABCDE";

test("CHALLENGER: QR & RegNo Parsing Microbenchmark (< 1µs/op target)", () => {
  const qrInputs = [
    VALID_UUID,
    VALID_UUID_UPPER,
    `https://snp-camps.org/p/${VALID_UUID}`,
    `https://snp-camps.org/print/${VALID_UUID}`,
    `https://snp-camps.org/patient/enter/${VALID_UUID}?ref=qr`,
    `snp:${VALID_UUID}`,
    `SNP:${VALID_UUID_UPPER}`,
    `https://snp-camps.org/scan?id=${VALID_UUID}`,
    `https://snp-camps.org/desk?scan=${VALID_UUID}`,
    `https://snp-camps.org/checkin?checkin=${VALID_UUID}`,
    `PREFIX_${VALID_UUID}_SUFFIX`,
    "INVALID_QR_STRING_NO_UUID",
    "Reg #10045",
    "2147483647",
    "2147483648",
    "00042",
  ];

  const ITERATIONS = 100_000;
  const start = performance.now();

  let validQrCount = 0;
  let validRegCount = 0;

  for (let i = 0; i < ITERATIONS; i++) {
    for (const input of qrInputs) {
      if (parsePatientIdFromQr(input) !== null) validQrCount++;
      if (parseRegistrationNumber(input) !== null) validRegCount++;
    }
  }

  const durationMs = performance.now() - start;
  const totalOps = ITERATIONS * qrInputs.length * 2;
  const usPerOp = (durationMs / totalOps) * 1000;

  console.log(
    `[CHALLENGER BENCHMARK] Executed ${totalOps} QR/RegNo parse ops in ${durationMs.toFixed(
      2
    )} ms (${usPerOp.toFixed(4)} µs/op) [valid QR: ${validQrCount}, valid RegNo: ${validRegCount}]`
  );

  assert.ok(
    usPerOp < 1.0,
    `PERFORMANCE REGRESSION: QR/RegNo parsing took ${usPerOp.toFixed(4)} µs/op (target: < 1.0 µs/op)`
  );
});

test("CHALLENGER: Aadhaar Normalization & Checksum Microbenchmark (< 1µs/op target)", () => {
  const testAadhaars = [
    "295489703417",
    "367468161557",
    "123456789012",
    "999999999999",
    "111111111111",
    "1234-5678-9012",
    "  9876 5432 1098  ",
    "ABC123456789012XYZ",
    "short",
  ];

  const ITERATIONS = 100_000;
  const start = performance.now();

  for (let i = 0; i < ITERATIONS; i++) {
    for (const raw of testAadhaars) {
      digitsOnly(raw);
      formatAadhaarDisplay(raw);
      aadhaarLast4(raw);
      isValidAadhaarNumber(raw);
    }
  }

  const durationMs = performance.now() - start;
  const totalOps = ITERATIONS * testAadhaars.length * 4;
  const usPerOp = (durationMs / totalOps) * 1000;

  console.log(
    `[CHALLENGER BENCHMARK] Executed ${totalOps} Aadhaar helper ops in ${durationMs.toFixed(
      2
    )} ms (${usPerOp.toFixed(4)} µs/op)`
  );

  assert.ok(
    usPerOp < 1.0,
    `PERFORMANCE REGRESSION: Aadhaar ops took ${usPerOp.toFixed(4)} µs/op (target: < 1.0 µs/op)`
  );
});

test("CHALLENGER: Password Generation Harness & Entropy Invariants", () => {
  assert.equal(DEFAULT_PATIENT_PASSWORD, "123456");

  const COUNT = 10_000;
  const patientPasswords = new Set();
  const allowedPatientChars = new Set("ABCDEFGHJKLMNPQRSTUVWXYZ23456789");

  const startPatient = performance.now();
  for (let i = 0; i < COUNT; i++) {
    const pw = generatePatientPassword();
    assert.equal(pw.length, 12, "Patient password must be exactly 12 characters");
    for (const char of pw) {
      assert.ok(
        allowedPatientChars.has(char),
        `Invalid character '${char}' in generated patient password`
      );
    }
    patientPasswords.add(pw);
  }
  const patientDurationMs = performance.now() - startPatient;
  const patientUsPerOp = (patientDurationMs / COUNT) * 1000;

  assert.equal(
    patientPasswords.size,
    COUNT,
    `Uniqueness failure: ${COUNT - patientPasswords.size} collisions detected in 10,000 generated passwords`
  );

  const staffPasswords = new Set();
  const allowedStaffChars = new Set(
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
  );

  const startStaff = performance.now();
  for (let i = 0; i < COUNT; i++) {
    const pw = generateStaffPassword();
    assert.equal(pw.length, 14, "Staff password must be exactly 14 characters");
    for (const char of pw) {
      assert.ok(
        allowedStaffChars.has(char),
        `Invalid character '${char}' in generated staff password`
      );
    }
    staffPasswords.add(pw);
  }
  const staffDurationMs = performance.now() - startStaff;
  const staffUsPerOp = (staffDurationMs / COUNT) * 1000;

  assert.equal(
    staffPasswords.size,
    COUNT,
    `Uniqueness failure: ${COUNT - staffPasswords.size} collisions detected in 10,000 staff passwords`
  );

  console.log(
    `[PASSWORD GENERATOR] 10,000 patient passwords generated in ${patientDurationMs.toFixed(
      2
    )} ms (${patientUsPerOp.toFixed(2)} µs/op, 0 collisions)`
  );
  console.log(
    `[PASSWORD GENERATOR] 10,000 staff passwords generated in ${staffDurationMs.toFixed(
      2
    )} ms (${staffUsPerOp.toFixed(2)} µs/op, 0 collisions)`
  );
});

test("CHALLENGER: Phone Normalization Harness (< 1µs/op target)", () => {
  assert.equal(normalizePhoneE164("9876543210"), "+919876543210");
  assert.equal(normalizePhoneE164("09876543210"), "+919876543210");
  assert.equal(normalizePhoneE164("919876543210"), "+919876543210");
  assert.equal(normalizePhoneE164("0919876543210"), "+919876543210");
  assert.equal(normalizePhoneE164("+91 98765-43210"), "+919876543210");

  assert.equal(normalizePhoneE164("1234567890"), null);
  assert.equal(normalizePhoneE164("98765"), null);
  assert.equal(normalizePhoneE164(""), null);

  const ITERATIONS = 100_000;
  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    normalizePhoneE164("+91 98765-43210");
    normalizePhoneE164("invalid-phone");
  }
  const durationMs = performance.now() - start;
  const usPerOp = (durationMs / (ITERATIONS * 2)) * 1000;

  console.log(
    `[PHONE BENCHMARK] Executed ${ITERATIONS * 2} phone normalization ops in ${durationMs.toFixed(
      2
    )} ms (${usPerOp.toFixed(4)} µs/op)`
  );

  assert.ok(usPerOp < 1.0, `Phone normalization took ${usPerOp.toFixed(4)} µs/op`);
});

test("CHALLENGER: ReDoS Vulnerability & Input Boundary Stress Harness", () => {
  // Bounded adversarial payloads (<= 512 chars)
  const boundedAdversarial = [
    "a/".repeat(200),
    "?" + "id=".repeat(100),
    "?" + "scan=".repeat(100),
    "?" + "checkin=".repeat(100),
    "snp:" + "12345678-".repeat(40),
    "A".repeat(500),
    "9".repeat(500),
    "00000000-0000-0000-0000-".repeat(15) + "000000000000",
  ];

  const ITERATIONS = 10_000;
  const startBounded = performance.now();

  for (let i = 0; i < ITERATIONS; i++) {
    for (const payload of boundedAdversarial) {
      assert.equal(parsePatientIdFromQr(payload), null);
      assert.equal(parseRegistrationNumber(payload), null);
      assert.equal(isValidAadhaarNumber(payload), false);
      assert.equal(normalizePhoneE164(payload), null);
    }
  }

  const durationBoundedMs = performance.now() - startBounded;
  const totalBoundedCalls = ITERATIONS * boundedAdversarial.length * 4; // 320,000 calls
  const usPerBoundedCall = (durationBoundedMs / totalBoundedCalls) * 1000;

  console.log(
    `[REDOS HARNESS] Bounded payloads (320,000 calls) executed in ${durationBoundedMs.toFixed(
      2
    )} ms (${usPerBoundedCall.toFixed(4)} µs/call)`
  );

  assert.ok(
    usPerBoundedCall < 5.0,
    `Bounded ReDoS payload latency too high: ${usPerBoundedCall.toFixed(4)} µs/call`
  );

  // Overlong input boundary analysis (> 512 chars)
  const overlongInput = "A".repeat(50_000);

  // 1. QR and RegNo parsing have explicit >512 length check: returns null in < 0.01 µs
  const startQrOverlong = performance.now();
  for (let i = 0; i < 10_000; i++) {
    parsePatientIdFromQr(overlongInput);
    parseRegistrationNumber(overlongInput);
  }
  const durationQrOverlong = performance.now() - startQrOverlong;
  console.log(
    `[BOUNDARY ANALYSIS] QR & RegNo early guard on 50k char input: ${(durationQrOverlong / 20000 * 1000).toFixed(4)} µs/call`
  );
  assert.ok(durationQrOverlong < 10, "QR & RegNo early length guard must reject in < 10ms");

  // 2. Inspect Aadhaar & Phone handling on overlong inputs
  const startOtherOverlong = performance.now();
  for (let i = 0; i < 100; i++) {
    isValidAadhaarNumber(overlongInput);
    normalizePhoneE164(overlongInput);
  }
  const durationOtherOverlong = performance.now() - startOtherOverlong;
  console.log(
    `[BOUNDARY FINDING] Aadhaar & Phone on 50k char input (no length cap): ${(durationOtherOverlong / 200 * 1000).toFixed(2)} µs/call`
  );
});

test("CHALLENGER: Data Invariants Verification (SQL Schema vs TypeScript Interfaces)", () => {
  const schemaPath = path.join(process.cwd(), "supabase/schema.sql");
  const schemaContent = fs.readFileSync(schemaPath, "utf-8");

  // 1. Verify queue_status ENUM invariant
  const sqlQueueStatus = schemaContent.match(
    /CREATE TYPE public\.queue_status AS ENUM \(\s*'registered',\s*'waiting',\s*'seen'\s*\);/
  );
  assert.ok(
    sqlQueueStatus !== null,
    "SQL schema must define queue_status ENUM with ('registered', 'waiting', 'seen')"
  );

  assert.equal(queueLabel("registered"), "Registered");
  assert.equal(queueLabel("waiting"), "In queue");
  assert.equal(queueLabel("seen"), "Doctor seen");

  assert.equal(queueTone("registered"), "default");
  assert.equal(queueTone("waiting"), "wait");
  assert.equal(queueTone("seen"), "ok");

  // 2. Verify user_role ENUM invariant
  const sqlUserRole = schemaContent.match(
    /CREATE TYPE public\.user_role AS ENUM \(\s*'admin',\s*'volunteer',\s*'doctor',\s*'patient'\s*\);/
  );
  assert.ok(
    sqlUserRole !== null,
    "SQL schema must define user_role ENUM with ('admin', 'volunteer', 'doctor', 'patient')"
  );

  // 3. Verify Aadhaar last4 constraint invariant
  const sqlAadhaarCheck = schemaContent.match(
    /CONSTRAINT patients_aadhaar_last4_check CHECK \(\(\(aadhaar_last4 IS NULL\) OR \(aadhaar_last4 ~ '\^\[0-9\]\{4\}\$'::text\)\)\)/
  );
  assert.ok(
    sqlAadhaarCheck !== null,
    "SQL schema must enforce patients_aadhaar_last4_check: NULL or exactly 4 digits"
  );

  assert.equal(aadhaarLast4("123456789012"), "9012");
  assert.ok(/^[0-9]{4}$/.test(aadhaarLast4("123456789012")));
  assert.equal(aadhaarLast4("123"), "");

  // 4. Verify Age constraint invariant
  const sqlAgeCheck = schemaContent.match(
    /CONSTRAINT patients_age_check CHECK \(\(\(age IS NULL\) OR \(\(age >= 0\) AND \(age < 150\)\)\)\)/
  );
  assert.ok(
    sqlAgeCheck !== null,
    "SQL schema must enforce patients_age_check: NULL or 0 <= age < 150"
  );

  assert.equal(ageFromDob("1850-01-01"), null);
  assert.equal(ageFromDob("2999-01-01"), null);

  // 5. Verify Gender constraint invariant
  const sqlGenderCheck = schemaContent.match(
    /CONSTRAINT patients_gender_check CHECK \(\(\(gender = ANY \(ARRAY\['M'::text, 'F'::text, 'O'::text\]\)\) OR \(gender IS NULL\)\)\)/
  );
  assert.ok(
    sqlGenderCheck !== null,
    "SQL schema must enforce patients_gender_check: M, F, O or NULL"
  );

  assert.equal(normalizeGender("male"), "M");
  assert.equal(normalizeGender("FEMALE"), "F");
  assert.equal(normalizeGender("OTHER"), "O");
  assert.equal(normalizeGender("invalid"), null);

  // 6. Verify Registration Number Sequence & Max Invariant
  const sqlRegSeq = schemaContent.match(
    /CREATE SEQUENCE public\.patient_reg_no_seq\s+START WITH 1000/
  );
  assert.ok(
    sqlRegSeq !== null,
    "SQL schema sequence patient_reg_no_seq must start at 1000"
  );

  assert.equal(parseRegistrationNumber(2147483647), 2147483647);
  assert.equal(parseRegistrationNumber(2147483648), null);

  // 7. Verify Date Formatting Invariants
  assert.equal(typeof formatCampDay("2026-07-23"), "string");

  console.log(
    "[DATA INVARIANTS] All SQL schema constraints (ENUMs, Aadhaar last4, Age range, Gender, RegNo sequence & max) verified against TypeScript types and helpers!"
  );
});
