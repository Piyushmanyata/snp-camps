/**
 * Pure validation for desk registration (#47).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { validatePatientForm } from "../src/lib/patient-form-validate.ts";

const dayId = "22222222-2222-4222-8222-222222222222";
const days = [{ id: dayId, is_full: false }];

function draft(over = {}) {
  return {
    campDayId: dayId,
    fullName: "Rina Das",
    gender: "",
    age: "42",
    address: "",
    phone: "",
    email: "",
    aadhaar: "",
    ...over,
  };
}

test("name + age only (no phone, no address) succeeds", () => {
  const result = validatePatientForm(draft(), days);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.values.fullName, "Rina Das");
  assert.equal(result.values.age, 42);
  assert.equal(result.values.phone, null);
  assert.equal(result.values.address, null);
  assert.equal(result.values.email, null);
  assert.equal(result.values.aadhaarLast4, null);
});

test("missing name fails", () => {
  const result = validatePatientForm(draft({ fullName: "  " }), days);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.field, "fullName");
});

test("missing age fails", () => {
  const result = validatePatientForm(draft({ age: "" }), days);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.field, "age");
});

test("invalid phone fails; blank phone ok", () => {
  assert.equal(validatePatientForm(draft({ phone: "123" }), days).ok, false);
  assert.equal(validatePatientForm(draft({ phone: "" }), days).ok, true);
  const ok = validatePatientForm(draft({ phone: "9876543210" }), days);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.values.phone, "9876543210");
});

test("aadhaar last-4 accepted when filled", () => {
  const result = validatePatientForm(draft({ aadhaar: "4321" }), days);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.values.aadhaarLast4, "4321");
});

test("full day rejected", () => {
  const result = validatePatientForm(draft(), [{ id: dayId, is_full: true }]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.field, "campDay");
});
