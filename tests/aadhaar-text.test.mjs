/**
 * Aadhaar card text parsing. parseDateOfBirth feeds derivePersonDuplicateKey,
 * so a date it accepts becomes part of a stored Person key.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseDateOfBirth } from "../src/lib/aadhaar-text.ts";

test("ISO and DMY dates parse to ISO", () => {
  assert.equal(parseDateOfBirth("1990-02-28"), "1990-02-28");
  assert.equal(parseDateOfBirth("28/02/1990"), "1990-02-28");
  assert.equal(parseDateOfBirth("28-02-1990"), "1990-02-28");
  assert.equal(parseDateOfBirth("5.3.1975"), "1975-03-05");
});

test("a leap day is accepted in a leap year and refused otherwise", () => {
  assert.equal(parseDateOfBirth("29/02/2024"), "2024-02-29");
  assert.equal(parseDateOfBirth("29/02/1990"), null);
});

test("impossible calendar days are refused, not normalised", () => {
  // day <= 31 alone let 31 February through as the literal string 1990-02-31,
  // which then keyed a Person that no corrected rescan could ever match.
  assert.equal(parseDateOfBirth("31/02/1990"), null);
  assert.equal(parseDateOfBirth("1990-02-31"), null);
  assert.equal(parseDateOfBirth("31/04/1990"), null);
  assert.equal(parseDateOfBirth("31/06/2001"), null);
});

test("out-of-range and malformed input is refused", () => {
  assert.equal(parseDateOfBirth("00/01/1990"), null);
  assert.equal(parseDateOfBirth("01/13/1990"), null);
  assert.equal(parseDateOfBirth("01/01/1800"), null);
  assert.equal(parseDateOfBirth("not a date"), null);
  assert.equal(parseDateOfBirth(""), null);
});
