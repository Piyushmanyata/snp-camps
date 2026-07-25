/**
 * Unit coverage for parsePhoneLinkResult (#18).
 * DB behaviour is covered in link-patient-phone.db.test.mjs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parsePhoneLinkResult } from "../src/lib/link-patient-phone.ts";

test("parsePhoneLinkResult: null and legacy uuid", () => {
  assert.deepEqual(parsePhoneLinkResult(null), { status: "no_match" });
  assert.deepEqual(parsePhoneLinkResult(undefined), { status: "no_match" });
  assert.deepEqual(parsePhoneLinkResult("abc-uuid"), {
    status: "linked",
    patient_id: "abc-uuid",
  });
});

test("parsePhoneLinkResult: structured statuses", () => {
  assert.deepEqual(parsePhoneLinkResult({ status: "no_match" }), {
    status: "no_match",
  });
  assert.deepEqual(
    parsePhoneLinkResult({ status: "linked", patient_id: "p1" }),
    { status: "linked", patient_id: "p1" },
  );
  const choose = parsePhoneLinkResult({
    status: "choose",
    ask_desk: true,
    candidates: [
      {
        id: "c1",
        reg_no: 12,
        full_name: "Asha",
        camp_day: "2026-07-25",
      },
      {
        id: "bad",
        reg_no: "x",
        full_name: "Skip",
        camp_day: null,
      },
    ],
  });
  assert.equal(choose?.status, "choose");
  if (choose?.status === "choose") {
    assert.equal(choose.ask_desk, true);
    assert.equal(choose.candidates.length, 1);
    assert.equal(choose.candidates[0].reg_no, 12);
    assert.equal(choose.candidates[0].camp_day, "2026-07-25");
  }
});

test("parsePhoneLinkResult: candidates never require phone/aadhaar fields", () => {
  const choose = parsePhoneLinkResult({
    status: "choose",
    ask_desk: false,
    candidates: [
      { id: "c1", reg_no: 1, full_name: "One", camp_day: null },
    ],
  });
  assert.equal(choose?.status, "choose");
  if (choose?.status === "choose") {
    assert.equal(Object.keys(choose.candidates[0]).sort().join(","), "camp_day,full_name,id,reg_no");
  }
});
