import assert from "node:assert/strict";
import test from "node:test";
import {
  isPasscodeNeverIssued,
  PASSCODE_NEVER_ISSUED_MARKER,
  passcodeIssuedPatchOnAuthWrite,
} from "../src/lib/passcode-issued.ts";

test("null passcode_issued_at is reported as never issued (legacy marker)", () => {
  assert.equal(isPasscodeNeverIssued(null), true);
  assert.equal(isPasscodeNeverIssued(undefined), true);
  assert.equal(isPasscodeNeverIssued("2026-07-25T12:00:00.000Z"), false);
  assert.match(PASSCODE_NEVER_ISSUED_MARKER, /No passcode issued/i);
  assert.doesNotMatch(PASSCODE_NEVER_ISSUED_MARKER, /broken/i);
});

test("successful Auth password write stamps passcode_issued_at", () => {
  const fixed = new Date("2026-07-25T15:00:00.000Z");
  const patch = passcodeIssuedPatchOnAuthWrite(true, () => fixed);
  assert.deepEqual(patch, {
    passcode_issued_at: "2026-07-25T15:00:00.000Z",
  });
});

test("failed Auth password write does not stamp", () => {
  assert.equal(passcodeIssuedPatchOnAuthWrite(false), null);
});
