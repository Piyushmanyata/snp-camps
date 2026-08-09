import assert from "node:assert/strict";
import test from "node:test";
import {
  isSameTranscription,
  validateClinicalTranscription,
  normalizeDiagnoses,
} from "../src/lib/clinical-transcription-validate.ts";
import { validateUnavailableMedicines } from "../src/lib/clinical-diagnoses.ts";

function draft(overrides = {}) {
  return {
    diagnoses: ["REFRACTION"],
    bloodSugar: null,
    bloodPressure: null,
    remarks: null,
    medicines: null,
    specs: null,
    ot: null,
    ...overrides,
  };
}

function validSpecs(overrides = {}) {
  return {
    type: "distance",
    right: { sphere: "-1.0" },
    left: { sphere: "-1.5" },
    pd: "62",
    ...overrides,
  };
}

test("clinical validation mirrors the SQL boundary cases", () => {
  const cases = [
    ["empty diagnoses", draft({ diagnoses: [] }), false],
    ["13 diagnoses", draft({ diagnoses: Array.from({ length: 13 }, () => "x") }), false],
    ["121-character diagnosis", draft({ diagnoses: ["x".repeat(121)] }), false],
    ["blood sugar 19", draft({ bloodSugar: "19" }), false],
    ["blood sugar 20", draft({ bloodSugar: "20" }), true],
    ["blood sugar 1000", draft({ bloodSugar: "1000" }), true],
    ["blood sugar 1001", draft({ bloodSugar: "1001" }), false],
    ["blood sugar non-numeric", draft({ bloodSugar: "high" }), false],
    ["blood pressure 120/80", draft({ bloodPressure: "120/80" }), true],
    ["blood pressure wrong separator", draft({ bloodPressure: "120-80" }), false],
    ["blood pressure systolic too low", draft({ bloodPressure: "39/80" }), false],
    ["blood pressure diastolic too high", draft({ bloodPressure: "120/201" }), false],
    ["Specs blank PD", draft({ specs: validSpecs({ pd: "" }) }), false],
    ["Specs PD 29", draft({ specs: validSpecs({ pd: "29" }) }), false],
    ["Specs PD 30", draft({ specs: validSpecs({ pd: "30" }) }), true],
    ["Specs PD 80", draft({ specs: validSpecs({ pd: "80" }) }), true],
    ["Specs PD 81", draft({ specs: validSpecs({ pd: "81" }) }), false],
    ["Specs non-numeric sphere", draft({ specs: validSpecs({ right: { sphere: "N6" } }) }), false],
    ["Specs axis 181", draft({ specs: validSpecs({ right: { sphere: "-1", axis: "181" } }) }), false],
    ["OT blank procedure", draft({ ot: { eye: "right", procedure: "" } }), false],
    [
      "fully valid payload",
      draft({
        diagnoses: ["REFRACTION", "Other note"],
        bloodSugar: "200.5",
        bloodPressure: "120/80",
        remarks: "Read paper",
        medicines: "Drops",
        specs: validSpecs({ right: { sphere: "-1", cylinder: "0", axis: "90", near: "1" } }),
        ot: { eye: "both", procedure: "Cataract review", notes: "Bring reports" },
      }),
      true,
    ],
  ];

  for (const [name, payload, expected] of cases) {
    assert.equal(validateClinicalTranscription(payload).ok, expected, name);
  }
});

test("stored diagnoses {options, other} validates; legacy flat array still validates", () => {
  assert.equal(
    validateClinicalTranscription(
      draft({ diagnoses: { options: ["REFRACTION"], other: "Free text" } }),
    ).ok,
    true,
  );
  assert.equal(
    validateClinicalTranscription(
      draft({ diagnoses: { options: [], other: null } }),
    ).ok,
    false,
  );
  assert.equal(
    validateClinicalTranscription(
      draft({ diagnoses: { options: ["REFRACTION"], other: "x".repeat(121) } }),
    ).ok,
    false,
  );
  assert.equal(
    validateClinicalTranscription(draft({ diagnoses: ["CATARACT"] })).ok,
    true,
  );
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
