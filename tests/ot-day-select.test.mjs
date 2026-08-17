import assert from "node:assert/strict";
import test from "node:test";
import {
  needsOtScheduleDay,
  pickEarliestFreeOtDay,
} from "../src/lib/ot-day-select.ts";

test("picks the earliest day with a free seat", () => {
  const pick = pickEarliestFreeOtDay([
    { id: "b", dayDate: "2026-08-20", seatLimit: 2, seatsTaken: 2 },
    { id: "a", dayDate: "2026-08-18", seatLimit: 2, seatsTaken: 1 },
    { id: "c", dayDate: "2026-08-19", seatLimit: 2, seatsTaken: 0 },
  ]);
  assert.equal(pick?.id, "a");
});

test("skips full days", () => {
  const pick = pickEarliestFreeOtDay([
    { id: "a", dayDate: "2026-08-18", seatLimit: 1, seatsTaken: 1 },
    { id: "b", dayDate: "2026-08-19", seatLimit: 1, seatsTaken: 0 },
  ]);
  assert.equal(pick?.id, "b");
});

test("all full returns null", () => {
  assert.equal(
    pickEarliestFreeOtDay([
      { id: "a", dayDate: "2026-08-18", seatLimit: 1, seatsTaken: 1 },
    ]),
    null,
  );
});

test("empty list returns null", () => {
  assert.equal(pickEarliestFreeOtDay([]), null);
});

test("ties on the same date break by id", () => {
  const pick = pickEarliestFreeOtDay([
    { id: "z", dayDate: "2026-08-18", seatLimit: 2, seatsTaken: 0 },
    { id: "a", dayDate: "2026-08-18", seatLimit: 2, seatsTaken: 0 },
  ]);
  assert.equal(pick?.id, "a");
});

test("OT deferred without a day must be refused before any busy flag", () => {
  assert.equal(needsOtScheduleDay("ot", "deferred", ""), true);
  assert.equal(needsOtScheduleDay("ot", "deferred", null), true);
  assert.equal(needsOtScheduleDay("ot", "deferred", "day-1"), false);
  assert.equal(needsOtScheduleDay("ot", "fulfilled", ""), false);
  assert.equal(needsOtScheduleDay("specs", "deferred", ""), false);
});
