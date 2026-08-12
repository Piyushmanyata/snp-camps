import assert from "node:assert/strict";
import test from "node:test";
import { formatClinicalRecordRows } from "../src/lib/clinical-record-format.ts";

function joined(data) {
  return formatClinicalRecordRows(data).join("\n");
}

test("formatClinicalRecordRows renders new-shape diagnoses {options, other}", () => {
  const text = joined({
    diagnoses: { options: ["Cataract", "Glaucoma"], other: "Dry eye" },
    bloodSugar: "110",
    bloodPressure: "120/80",
    remarks: "Rest",
    medicines: "Moxi drops",
  });
  assert.match(text, /Diagnosis: Cataract, Glaucoma · Other: Dry eye/);
  assert.match(text, /Blood sugar: 110/);
  assert.match(text, /BP: 120\/80/);
  assert.match(text, /Remarks: Rest/);
  assert.match(text, /Medicines: Moxi drops/);
  assert.equal(text.includes("[object Object]"), false);
  assert.equal(text.includes("{"), false);
  assert.equal(text.includes("}"), false);
});

test("formatClinicalRecordRows renders legacy flat-array diagnoses", () => {
  const text = joined({
    diagnoses: ["Cataract", "Refractive error"],
  });
  assert.match(text, /Diagnosis: Cataract, Refractive error/);
  assert.equal(text.includes("[object Object]"), false);
  assert.equal(/\{[\s\S]*"options"/.test(text), false);
  assert.equal(text.includes("JSON"), false);
});

test("formatClinicalRecordRows renders specs and OT without JSON", () => {
  const text = joined({
    specs: {
      type: "bifocal",
      pd: "62",
      right: { sphere: "-1.00", cylinder: "-0.50", axis: "90", vision: "6/6", near: "N6" },
      left: { sphere: "", cylinder: "", axis: "", vision: "", near: "" },
    },
    ot: { eye: "right", procedure: "SICS", notes: "UA" },
  });
  assert.match(text, /Specs: bifocal · PD 62/);
  assert.match(text, /RE -1\.00 \/ -0\.50 \/ 90 \/ 6\/6 \/ N6/);
  assert.equal(text.includes("LE "), false);
  assert.match(text, /OT: right · SICS/);
  assert.match(text, /Notes: UA/);
  assert.equal(text.includes("[object Object]"), false);
  assert.equal(text.includes('"sphere"'), false);
});

test("formatClinicalRecordRows skips empty values and never dumps objects", () => {
  const rows = formatClinicalRecordRows({
    diagnoses: { options: [], other: null },
    bloodSugar: "",
    remarks: null,
    nested: { a: 1 },
    flag: true,
    count: 0,
  });
  assert.deepEqual(
    rows.filter((row) => row.startsWith("Blood sugar") || row.startsWith("Remarks") || row.startsWith("Diagnosis")),
    [],
  );
  assert.ok(rows.some((row) => row === "flag: true"));
  assert.ok(rows.some((row) => row === "count: 0"));
  assert.equal(rows.some((row) => row.includes("[object Object]")), false);
  assert.equal(rows.some((row) => row.includes("{")), false);
});
