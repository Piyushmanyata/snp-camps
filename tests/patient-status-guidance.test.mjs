import assert from "node:assert/strict";
import test from "node:test";
import { getPatientStatusGuidance } from "../src/lib/patient-status-guidance.ts";

test("registered patients are told to check in", () => {
  const result = getPatientStatusGuidance("registered", 0);
  assert.equal(result.label, "Registered");
  assert.match(result.instruction, /check in/i);
});

test("waiting patients receive queue guidance", () => {
  const result = getPatientStatusGuidance("waiting", 0);
  assert.equal(result.label, "Waiting for doctor");
  assert.match(result.instruction, /30 seconds/i);
});

test("seen patients distinguish pending treatment from completion", () => {
  const pending = getPatientStatusGuidance("seen", 2);
  assert.equal(pending.label, "Consultation complete");
  assert.match(pending.instruction, /pending treatments/i);

  const complete = getPatientStatusGuidance("seen", 0);
  assert.equal(complete.label, "Camp visit complete");
  assert.equal(complete.tone, "complete");
});

test("unknown status fails safely with desk guidance", () => {
  const result = getPatientStatusGuidance("unexpected", 0);
  assert.equal(result.label, "Status unavailable");
  assert.match(result.instruction, /registration desk/i);
});
