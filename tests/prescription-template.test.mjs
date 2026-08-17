/**
 * Prescription template resolution. These strings are printed on the paper
 * clinical record, so a truncation that corrupts a glyph corrupts the record.
 *
 * The caps are MAX_SHORT_TEXT 80 and MAX_FOOTER_TEXT 180. Each case below picks
 * a cluster width that does NOT divide its cap evenly — otherwise a code-unit
 * slice lands on a boundary by luck and the test proves nothing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PRESCRIPTION_TEMPLATE,
  resolvePrescriptionTemplate,
} from "../src/lib/prescription-template.ts";

const hasLoneSurrogate = (value) => /[\uD800-\uDFFF]/.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""));

test("a non-object falls back to the default template", () => {
  assert.deepEqual(resolvePrescriptionTemplate(null), DEFAULT_PRESCRIPTION_TEMPLATE);
  assert.deepEqual(resolvePrescriptionTemplate("x"), DEFAULT_PRESCRIPTION_TEMPLATE);
});

test("an over-long Devanagari label is cut on a grapheme boundary", () => {
  // "क्ष" is one grapheme of 3 UTF-16 code units; 80 % 3 === 2, so a code-unit
  // slice at the 80 cap strips the ष off its virama and prints a broken glyph.
  const operationLabel = "क्ष".repeat(40);
  assert.ok(operationLabel.length > 80);

  const out = resolvePrescriptionTemplate({ operationLabel }).operationLabel;

  assert.ok(out.length <= 80);
  assert.equal(out.length % 3, 0, "cut must land on a whole cluster");
  assert.equal(out, "क्ष".repeat(out.length / 3));
});

test("an over-long Devanagari footer is cut on a grapheme boundary", () => {
  // One ASCII char shifts the alignment so the 4-unit clusters no longer divide
  // the 180 cap evenly.
  const footerNote = `x${"क्षि".repeat(60)}`;
  assert.ok(footerNote.length > 180);

  const out = resolvePrescriptionTemplate({ footerNote }).footerNote;

  assert.ok(out.length <= 180);
  assert.equal(out.slice(0, 1), "x");
  assert.equal((out.length - 1) % 4, 0, "cut must land on a whole cluster");
  assert.equal(out, `x${"क्षि".repeat((out.length - 1) / 4)}`);
});

test("an over-long astral string never keeps half a surrogate pair", () => {
  // 2-unit pairs after a 1-unit prefix: 80 - 1 is odd, so a code-unit slice
  // ends inside a pair and leaves a lone surrogate.
  const operationLabel = `x${"\u{1F600}".repeat(60)}`;

  const out = resolvePrescriptionTemplate({ operationLabel }).operationLabel;

  assert.ok(out.length <= 80);
  assert.equal(hasLoneSurrogate(out), false, "must not end mid surrogate pair");
});

test("a short value passes through trimmed but intact", () => {
  const { footerNote } = resolvePrescriptionTemplate({
    footerNote: "  कृपया चश्मा साथ लायें  ",
  });
  assert.equal(footerNote, "कृपया चश्मा साथ लायें");
});
