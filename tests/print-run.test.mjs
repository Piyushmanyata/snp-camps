import assert from "node:assert/strict";
import test from "node:test";
import { resolvePrintRun } from "../src/lib/print-run.ts";

test("every presence write succeeded: paper prints and the desk is told", () => {
  const outcome = resolvePrintRun([{ ok: true }, { ok: true }]);
  assert.equal(outcome.print, true);
  assert.equal(outcome.tone, "success");
  assert.match(outcome.text, /Print dialog khul gaya hai/);
});

test("a partial failure still prints the paper for the patients it recorded", () => {
  const outcome = resolvePrintRun([
    { ok: true },
    { ok: false, error: "Camp band hai." },
  ]);
  assert.equal(
    outcome.print,
    true,
    "presence was recorded for one patient, so paper must come out",
  );
  assert.equal(outcome.tone, "error");
  assert.equal(outcome.text, "Camp band hai.");
});

test("no presence recorded at all: nothing prints and the reason surfaces", () => {
  const outcome = resolvePrintRun([{ ok: false, error: "Camp band hai." }]);
  assert.equal(outcome.print, false);
  assert.equal(outcome.tone, "error");
  assert.equal(outcome.text, "Camp band hai.");
});

test("a refusal with no message falls back to the Hinglish desk copy", () => {
  const outcome = resolvePrintRun([{ ok: false }]);
  assert.equal(outcome.print, false);
  assert.match(outcome.text, /Dobara try karein/);
});

test("an empty sheet never opens the print dialog, and never claims it did", () => {
  const outcome = resolvePrintRun([]);
  assert.equal(outcome.print, false);
  assert.equal(outcome.tone, "error");
  assert.doesNotMatch(
    outcome.text,
    /record ho gayi|Print dialog khul gaya hai/,
    "a run that printed nothing must not report presence as recorded",
  );
});
