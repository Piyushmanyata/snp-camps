import test from "node:test";
import assert from "node:assert/strict";
import {
  derivePersonDuplicateKey,
  normalizePersonName,
} from "../src/lib/person-duplicate-key.ts";

const PEPPER_ENV = {
  AADHAAR_HASH_PEPPER: "test-pepper-for-person-key-unit-suite",
};

const base = {
  aadhaarLast4: "1098",
  name: "Vikram Sharma",
  dateOfBirth: "1990-08-15",
  gender: "M",
};

test("normalizePersonName case-folds and collapses whitespace", () => {
  assert.equal(normalizePersonName("  Vikram   SHARMA "), "vikram sharma");
});

test("same card twice yields the identical key", () => {
  const a = derivePersonDuplicateKey(base, PEPPER_ENV);
  const b = derivePersonDuplicateKey({ ...base }, PEPPER_ENV);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("name whitespace and letter case do not change the key", () => {
  const a = derivePersonDuplicateKey(base, PEPPER_ENV);
  const b = derivePersonDuplicateKey(
    {
      ...base,
      name: "  vikram   sharma  ",
    },
    PEPPER_ENV,
  );
  assert.equal(a, b);
});

test("Devanagari name is stable across re-derivation", () => {
  const input = {
    ...base,
    name: "विक्रम शर्मा",
  };
  const a = derivePersonDuplicateKey(input, PEPPER_ENV);
  const b = derivePersonDuplicateKey(
    { ...input, name: "  विक्रम   शर्मा  " },
    PEPPER_ENV,
  );
  assert.equal(a, b);
  assert.notEqual(a, derivePersonDuplicateKey(base, PEPPER_ENV));
});

test("different DOB with same name and last-4 yields a different key", () => {
  const a = derivePersonDuplicateKey(base, PEPPER_ENV);
  const b = derivePersonDuplicateKey(
    { ...base, dateOfBirth: "1991-08-15" },
    PEPPER_ENV,
  );
  assert.notEqual(a, b);
});

test("different gender with same name and last-4 yields a different key", () => {
  const a = derivePersonDuplicateKey(base, PEPPER_ENV);
  const b = derivePersonDuplicateKey({ ...base, gender: "F" }, PEPPER_ENV);
  assert.notEqual(a, b);
});

test("DMY and ISO date forms normalise to the same key", () => {
  const iso = derivePersonDuplicateKey(base, PEPPER_ENV);
  const dmy = derivePersonDuplicateKey(
    { ...base, dateOfBirth: "15-08-1990" },
    PEPPER_ENV,
  );
  assert.equal(iso, dmy);
});

test("missing pepper fails loudly", () => {
  assert.throws(
    () =>
      derivePersonDuplicateKey(base, {
        AADHAAR_HASH_PEPPER: "",
        AADHAAR_KYC_PEPPER: "",
        AADHAAR_PEPPER: "",
      }),
    /AADHAAR_HASH_PEPPER|AADHAAR_KYC_PEPPER|required/i,
  );
});
