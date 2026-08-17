import assert from "node:assert/strict";
import test from "node:test";
import {
  MANUAL_EXCEPTION_ATTEMPT_THRESHOLD,
  manualExceptionUnlocked,
  nextFailedScanAttempts,
} from "../src/lib/manual-exception-attempts.ts";

test("the shared attempt threshold is two", () => {
  assert.equal(MANUAL_EXCEPTION_ATTEMPT_THRESHOLD, 2);
});

test("one failed scan does not unlock manual entry", () => {
  const count = nextFailedScanAttempts(0, "failed-scan");
  assert.equal(count, 1);
  assert.equal(manualExceptionUnlocked(count), false);
});

test("two failed scans unlock manual entry", () => {
  const first = nextFailedScanAttempts(0, "failed-scan");
  const second = nextFailedScanAttempts(first, "failed-scan");
  assert.equal(second, 2);
  assert.equal(manualExceptionUnlocked(second), true);
});

test("a new registration zeroes the count after failures", () => {
  const afterFailures = nextFailedScanAttempts(
    nextFailedScanAttempts(0, "failed-scan"),
    "failed-scan",
  );
  assert.equal(manualExceptionUnlocked(afterFailures), true);
  const reset = nextFailedScanAttempts(afterFailures, "new-registration");
  assert.equal(reset, 0);
  assert.equal(manualExceptionUnlocked(reset), false);
});
