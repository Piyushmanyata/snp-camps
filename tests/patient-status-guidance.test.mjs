import assert from "node:assert/strict";
import test from "node:test";
import { getPatientStatusGuidance } from "../src/lib/patient-status-guidance.ts";

// Patients read Hinglish (CONTEXT.md §Language). These assertions are the guard
// against an English regression leaking back onto the status page.

test("registered patients are sent to their venue, not into a line", () => {
  const result = getPatientStatusGuidance("registered");
  assert.equal(result.label, "Registration ho gaya");
  assert.match(result.instruction, /venue par jaayein/i);
  assert.equal(result.tone, "neutral");
});

test("a retired waiting status falls through to safe desk guidance", () => {
  // `waiting` is dead on the enum but not droppable, so it must not resolve to
  // line copy if a residual row ever reaches the page (ADR 0013).
  const result = getPatientStatusGuidance("waiting");
  assert.equal(result.label, "Status nahi mil paaya");
  assert.equal(result.tone, "neutral");
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
      /consultation|treatment|pending|check in|queue|line mein/i,
      `retired English or line copy leaked back into "${status}"`,
    );
  }
});
