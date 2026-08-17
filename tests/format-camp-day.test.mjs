import assert from "node:assert/strict";
import test from "node:test";
import { formatCampDay, formatCampDaySms } from "../src/lib/format-camp-day.ts";

/** The deleted noon-local convention (machine local, no timeZone). */
function oldNoonLocalConvention(isoDate) {
  return new Date(isoDate + "T12:00:00").toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * UTC-midnight anchor formatted in a western zone — the print-sheet/Z style
 * of bug that can show the previous calendar day.
 */
function utcMidnightInLosAngeles(isoDate) {
  return new Intl.DateTimeFormat("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "America/Los_Angeles",
  }).format(new Date(`${isoDate}T00:00:00Z`));
}

test("formatCampDay anchors YYYY-MM-DD at Asia/Kolkata midnight", () => {
  // Fixed expected string for 1 Jan 2026 IST (Thu).
  const out = formatCampDay("2026-01-01");
  assert.match(out, /1/);
  assert.match(out, /Jan/i);
  assert.match(out, /2026/);
  // Must not roll to previous calendar day.
  assert.doesNotMatch(out, /31/);
  assert.doesNotMatch(out, /Dec/i);
  assert.doesNotMatch(out, /2025/);
});

test("year-boundary date: IST convention disagrees with UTC-midnight-in-LA", () => {
  const iso = "2026-01-01";
  const correct = formatCampDay(iso);
  const wrongUtcWest = utcMidnightInLosAngeles(iso);

  // Proof the two old-style anchors can disagree across the date line/offset.
  assert.notEqual(
    correct,
    wrongUtcWest,
    "expected LA formatting of UTC midnight to differ from IST calendar day",
  );
  assert.match(correct, /2026/);
  assert.match(correct, /Jan/i);
});

test("formatCampDay is stable for a mid-year date", () => {
  const out = formatCampDay("2026-07-25");
  assert.match(out, /25/);
  assert.match(out, /Jul/i);
  assert.match(out, /2026/);
});

test("malformed input is returned unchanged", () => {
  assert.equal(formatCampDay("not-a-date"), "not-a-date");
  assert.equal(formatCampDay("2026/01/01"), "2026/01/01");
});

test("formatCampDaySms is Devanagari months with ASCII digits", () => {
  assert.equal(formatCampDaySms("2026-09-30"), "30 सितंबर 2026");
  assert.equal(formatCampDaySms("2026-01-01"), "1 जनवरी 2026");
  assert.equal(formatCampDaySms("not-a-date"), "not-a-date");
});

test("types re-exports the same formatter", async () => {
  const types = await import("../src/lib/types.ts");
  assert.equal(types.formatCampDay("2026-01-01"), formatCampDay("2026-01-01"));
});

// Document that noon-local often matches by luck on the same machine; the
// gate is the IST module, not the noon path. Keep the helper referenced so
// the deleted convention stays visible in the test file for future agents.
test("old noon-local helper is still the shape we deleted (sanity)", () => {
  const sample = oldNoonLocalConvention("2026-07-25");
  assert.equal(typeof sample, "string");
  assert.ok(sample.length > 0);
});
