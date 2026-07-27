import assert from "node:assert/strict";
import test from "node:test";
import {
  COUNTER_STATIONS,
  isPatientCompletedDerived,
} from "../src/lib/counter-desk.ts";

test("Counter Desk Catalog: contains expected stations (pharmacy, spectacles, ot)", () => {
  assert.equal(COUNTER_STATIONS.length, 3);
  const kinds = COUNTER_STATIONS.map((s) => s.kind);
  assert.deepEqual(kinds, ["pharmacy", "spectacles", "ot"]);
});

test("isPatientCompletedDerived: computes derived completion correctly", () => {
  // Rule 1: A patient who has collected everything is NOT given a new queue status; completion is derived (seen + no pending orders).
  assert.equal(
    isPatientCompletedDerived("seen", [
      { status: "fulfilled" },
      { status: "deferred" },
      { status: "cancelled" },
    ]),
    true,
    "seen + all orders resolved (fulfilled/deferred/cancelled) → completed"
  );

  assert.equal(
    isPatientCompletedDerived("seen", []),
    true,
    "seen + 0 treatment orders → completed"
  );

  assert.equal(
    isPatientCompletedDerived("seen", [
      { status: "fulfilled" },
      { status: "pending" },
    ]),
    false,
    "seen + at least 1 pending order → not completed"
  );

  assert.equal(
    isPatientCompletedDerived("waiting", [{ status: "fulfilled" }]),
    false,
    "waiting status → not completed"
  );

  assert.equal(
    isPatientCompletedDerived("registered", []),
    false,
    "registered status → not completed"
  );
});
