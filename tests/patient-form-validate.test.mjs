/**
 * Pure validation for desk registration (#47).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  isDeskDaySelectable,
  validatePatientForm,
} from "../src/lib/patient-form-validate.ts";

const dayId = "22222222-2222-4222-8222-222222222222";
const days = [{ id: dayId, is_full: false, day_date: "2026-07-31" }];

function draft(over = {}) {
  return {
    campDayId: dayId,
    fullName: "Rina Das",
    gender: "",
    age: "42",
    address: "",
    phone: "9876543210",
    email: "",
    aadhaar: "",
    ...over,
  };
}

test("name + age + household phone succeeds", () => {
  const result = validatePatientForm(draft(), days);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.values.fullName, "Rina Das");
  assert.equal(result.values.age, 42);
  assert.equal(result.values.phone, "9876543210");
  assert.equal(result.values.address, null);
  assert.equal(result.values.email, null);
  assert.equal(result.values.aadhaarLast4, null);
});

test("a whitespace age is refused, not coerced to 0", () => {
  const result = validatePatientForm(draft({ age: " " }), days);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.field, "age");
});

test("an exponent or hex age is refused, not coerced", () => {
  for (const age of ["1e2", "0x40", "4.0", "+7"]) {
    const result = validatePatientForm(draft({ age }), days);
    assert.equal(result.ok, false, `expected ${age} to be refused`);
  }
});

test("a camp day id absent from the day list is refused", () => {
  const result = validatePatientForm(
    draft({ campDayId: "33333333-3333-4333-8333-333333333333" }),
    days,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.field, "campDay");
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

test("invalid, blank, and repeated-digit phones fail", () => {
  assert.equal(validatePatientForm(draft({ phone: "123" }), days).ok, false);
  assert.equal(validatePatientForm(draft({ phone: "" }), days).ok, false);
  assert.equal(validatePatientForm(draft({ phone: "9999999999" }), days).ok, false);
  const ok = validatePatientForm(draft({ phone: "9876543210" }), days);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.values.phone, "9876543210");
});

test("aadhaar last-4 accepted when filled", () => {
  const result = validatePatientForm(draft({ aadhaar: "4321" }), days);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.values.aadhaarLast4, "4321");
});

test("future full day rejected; today full still allowed for desk walk-in", () => {
  const futureFull = validatePatientForm(
    draft(),
    [{ id: dayId, is_full: true, day_date: "2026-08-15" }],
    { todayIso: "2026-07-31" },
  );
  assert.equal(futureFull.ok, false);
  if (!futureFull.ok) assert.equal(futureFull.field, "campDay");

  const todayFull = validatePatientForm(
    draft(),
    [{ id: dayId, is_full: true, day_date: "2026-07-31" }],
    { todayIso: "2026-07-31" },
  );
  assert.equal(todayFull.ok, true);
  assert.equal(
    isDeskDaySelectable(
      { id: dayId, is_full: true, day_date: "2026-07-31" },
      "2026-07-31",
    ),
    true,
  );
});
