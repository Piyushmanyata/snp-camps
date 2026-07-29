import assert from "node:assert/strict";
import test from "node:test";
import { getPatientStatusGuidance } from "../src/lib/patient-status-guidance.ts";

// Patients read Hinglish (CONTEXT.md §Language). These assertions are the guard
// against an English regression leaking back onto the status page.

test("registered patients are sent to the desk, not into the queue", () => {
  const result = getPatientStatusGuidance("registered");
  assert.equal(result.label, "Registration ho gaya");
  assert.match(result.instruction, /desk par jaayein/i);
  assert.equal(result.tone, "neutral");
});

test("waiting patients receive queue guidance", () => {
  const result = getPatientStatusGuidance("waiting");
  assert.equal(result.label, "Line mein hain");
  assert.match(result.instruction, /30 second/i);
  assert.equal(result.tone, "waiting");
});

test("seen is terminal and has no pending-treatment arm", () => {
  const result = getPatientStatusGuidance("seen");
  assert.equal(result.label, "Aapka number ho gaya");
  assert.equal(result.tone, "complete");
});

test("unknown status fails safely with desk guidance", () => {
  const result = getPatientStatusGuidance("unexpected");
  assert.equal(result.label, "Status nahi mil paaya");
  assert.match(result.instruction, /desk/i);
});

test("guidance is Hinglish, never English clinical copy", () => {
  for (const status of ["registered", "waiting", "seen", "unexpected"]) {
    const { label, instruction } = getPatientStatusGuidance(status);
    assert.doesNotMatch(
      `${label} ${instruction}`,
      /consultation|treatment|pending|check in/i,
      `retired English copy leaked back into "${status}"`,
    );
  }
});
