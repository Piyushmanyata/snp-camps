/**
 * The browser no longer mirrors assert_valid_clinical_data (ADR 0015): the
 * database is the no, and the SQL boundary cases are proved against Postgres
 * in issue-124-clinical.db.test.mjs rather than against a TypeScript replica
 * that could disagree with it.
 *
 * What remains here is the screen-level no-op-correction hint, which the
 * database deliberately does not make.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  isSameTranscription,
  normalizeDiagnoses,
} from "../src/lib/clinical-transcription-validate.ts";
import { validateUnavailableMedicines } from "../src/lib/clinical-diagnoses.ts";

test("the browser keeps no copy of the SQL save rules", async () => {
  const validator = await import(
    "../src/lib/clinical-transcription-validate.ts"
  );
  assert.equal(
    validator.validateClinicalTranscription,
    undefined,
    "a second source of truth for save/correct must not come back (ADR 0015)",
  );
  assert.equal(validator.validateDiagnosesField, undefined);
});

test("normalizeDiagnoses is stable for both shapes and template-splits legacy", () => {
  assert.deepEqual(normalizeDiagnoses({ options: ["A"], other: "B" }), {
    options: ["A"],
    other: "B",
  });
  assert.deepEqual(normalizeDiagnoses(["A", "free"], ["A", "C"]), {
    options: ["A"],
    other: "free",
  });
  assert.deepEqual(normalizeDiagnoses(["A", "C"]), {
    options: ["A", "C"],
    other: null,
  });
});

test("a stored split survives the live template, retired labels included", () => {
  // ADR 0011/0015: desk, history and Camp Records Export all read the stored
  // {options, other} split. knownOptions exists only to split *legacy flat
  // arrays*; it must never re-split a stored split against today's template,
  // or a later template edit would rewrite history.
  const stored = { options: ["RETIRED_DX", "REFRACTION"], other: "free text" };
  const todaysTemplate = ["REFRACTION", "CATARACT"];

  assert.deepEqual(normalizeDiagnoses(stored), {
    options: ["RETIRED_DX", "REFRACTION"],
    other: "free text",
  });
  assert.deepEqual(
    normalizeDiagnoses(stored, todaysTemplate),
    normalizeDiagnoses(stored),
    "the template must not move a retired stored option into Other",
  );
  assert.deepEqual(
    normalizeDiagnoses(stored, []),
    normalizeDiagnoses(stored),
    "an empty template must not empty a stored split either",
  );
});

test("isSameTranscription ignores key order and legacy↔explicit diagnoses shape", () => {
  assert.equal(
    isSameTranscription(
      { diagnoses: ["REFRACTION"], specs: { pd: "62", type: "distance" } },
      { specs: { type: "distance", pd: "62" }, diagnoses: ["REFRACTION"] },
    ),
    true,
  );
  assert.equal(
    isSameTranscription({ diagnoses: ["REFRACTION"] }, { diagnoses: ["CATARACT"] }),
    false,
  );
  assert.equal(isSameTranscription({ remarks: null }, { remarks: "" }), false);
  assert.equal(
    isSameTranscription(
      { diagnoses: ["REFRACTION", "custom note"] },
      { diagnoses: { options: ["REFRACTION"], other: "custom note" } },
    ),
    true,
  );
  // Multi free-text legacy vs semicolon-joined Other: equal, no false correction.
  assert.equal(
    isSameTranscription(
      { diagnoses: ["note one", "note two"] },
      { diagnoses: { options: [], other: "note one; note two" } },
    ),
    true,
  );
  // Genuinely changed content is not equal.
  assert.equal(
    isSameTranscription(
      { diagnoses: ["note one", "note two"] },
      { diagnoses: { options: [], other: "note one; note three" } },
    ),
    false,
  );
  // A single legacy free-text entry that itself contains a semicolon splits the
  // same way on both sides, so re-saving it unchanged is not a correction.
  assert.equal(
    isSameTranscription(
      { diagnoses: ["Diabetes; Type 2"] },
      { diagnoses: { options: [], other: "Diabetes; Type 2" } },
    ),
    true,
  );
  // The same holds alongside a checked template option.
  assert.equal(
    isSameTranscription(
      { diagnoses: ["REFRACTION", "Diabetes; Type 2"] },
      { diagnoses: { options: ["REFRACTION"], other: "Diabetes; Type 2" } },
    ),
    true,
  );
});

test("unavailable medicines bounds", () => {
  assert.equal(validateUnavailableMedicines(null).ok, false);
  assert.equal(validateUnavailableMedicines([]).ok, false);
  assert.equal(validateUnavailableMedicines(["Lubricant"]).ok, true);
  assert.equal(validateUnavailableMedicines(["x".repeat(121)]).ok, false);
  assert.equal(
    validateUnavailableMedicines(Array.from({ length: 13 }, () => "a")).ok,
    false,
  );
});
