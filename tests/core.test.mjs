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
  parsePatientIdFromQr,
  patientPrintUrl,
  patientScanUrl,
} from "../src/lib/qr.ts";
import { generatePatientPassword } from "../src/lib/patient-password.ts";

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

test("QR parser accepts only supported patient identifiers", () => {
  const id = "A0B1C2D3-E4F5-4678-9ABC-DEF012345678";
  const normalized = id.toLowerCase();
  assert.equal(parsePatientIdFromQr(id), normalized);
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
  assert.equal(parsePatientIdFromQr("javascript:alert(1)"), null);
  assert.equal(parsePatientIdFromQr("/patient/enter/not-a-uuid"), null);
});

test("patient URLs are canonical and passwords avoid ambiguous characters", () => {
  const id = "a0b1c2d3-e4f5-4678-9abc-def012345678";
  assert.equal(patientScanUrl(id, "https://camp.example/"), "https://camp.example/patient/enter/" + id);
  assert.equal(patientPrintUrl(id, "https://camp.example/"), "https://camp.example/print/" + id);

  const generated = new Set(
    Array.from({ length: 20 }, () => generatePatientPassword(12)),
  );
  assert.equal(generated.size, 20);
  for (const password of generated) {
    assert.match(password, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/);
  }
});
