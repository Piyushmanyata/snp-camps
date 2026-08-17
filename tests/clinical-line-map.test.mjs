import assert from "node:assert/strict";
import test from "node:test";
import {
  CLINICAL_LINES,
  lineDecisions,
  lineKind,
  otherSpecsLine,
} from "../src/lib/clinical-line-map.ts";

test("each of the four lines offers exactly its allowed decisions", () => {
  assert.deepEqual([...CLINICAL_LINES], [
    "fixed_power",
    "medicine",
    "specs_to_make",
    "ot",
  ]);
  assert.equal(lineKind("fixed_power"), "specs");
  assert.deepEqual(lineDecisions("fixed_power"), ["fulfilled", "not_required"]);
  assert.equal(lineKind("medicine"), "medicine");
  assert.deepEqual(lineDecisions("medicine"), [
    "fulfilled",
    "not_available",
    "not_required",
  ]);
  assert.equal(lineKind("specs_to_make"), "specs");
  assert.deepEqual(lineDecisions("specs_to_make"), ["deferred", "not_required"]);
  assert.equal(lineKind("ot"), "ot");
  assert.deepEqual(lineDecisions("ot"), [
    "fulfilled",
    "deferred",
    "not_required",
  ]);
  assert.equal(otherSpecsLine("fixed_power"), "specs_to_make");
  assert.equal(otherSpecsLine("specs_to_make"), "fixed_power");
  assert.equal(otherSpecsLine("ot"), null);
});

test("each line maps to one detail kind", () => {
  assert.equal(lineKind("fixed_power"), "specs");
  assert.equal(lineKind("specs_to_make"), "specs");
  assert.equal(lineKind("medicine"), "medicine");
  assert.equal(lineKind("ot"), "ot");
});
