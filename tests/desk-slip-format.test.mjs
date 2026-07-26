import assert from "node:assert/strict";
import test from "node:test";

import {
  DESK_SLIP_FORMAT_DEFAULT,
  DESK_SLIP_FORMAT_STORAGE_KEY,
  deskSlipFormatLabel,
  isDeskSlipFormat,
  parseDeskSlipFormat,
} from "../src/lib/desk-slip-format.ts";

test("default format is a4 multi-up", () => {
  assert.equal(DESK_SLIP_FORMAT_DEFAULT, "a4");
  assert.equal(parseDeskSlipFormat(undefined), "a4");
  assert.equal(parseDeskSlipFormat(null), "a4");
  assert.equal(parseDeskSlipFormat(""), "a4");
  assert.equal(parseDeskSlipFormat("nope"), "a4");
});

test("parse accepts a4 and thermal58 (case-insensitive)", () => {
  assert.equal(parseDeskSlipFormat("a4"), "a4");
  assert.equal(parseDeskSlipFormat("A4"), "a4");
  assert.equal(parseDeskSlipFormat("thermal58"), "thermal58");
  assert.equal(parseDeskSlipFormat(" Thermal58 "), "thermal58");
});

test("isDeskSlipFormat is strict", () => {
  assert.equal(isDeskSlipFormat("a4"), true);
  assert.equal(isDeskSlipFormat("thermal58"), true);
  assert.equal(isDeskSlipFormat("thermal"), false);
  assert.equal(isDeskSlipFormat(58), false);
});

test("labels and storage key stay stable for station setting", () => {
  assert.equal(deskSlipFormatLabel("a4"), "A4 multi-up");
  assert.equal(deskSlipFormatLabel("thermal58"), "58mm thermal");
  assert.equal(DESK_SLIP_FORMAT_STORAGE_KEY, "snp.deskSlipFormat");
});
