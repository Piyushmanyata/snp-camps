import assert from "node:assert/strict";
import test from "node:test";
import { isPrintWindowOpen } from "../src/lib/print-window.ts";
import { ucs2SegmentCount, SMS_UCS2_SINGLE } from "../src/lib/sms-segments.ts";
import { fillRegistrationSms } from "../src/lib/registration-sms.ts";
import { pickEarliestFreeOtDay } from "../src/lib/ot-day-select.ts";
import { lineDecisions } from "../src/lib/clinical-line-map.ts";

test("fresh consumer gets real return values from shipped modules", () => {
  const now = new Date("2026-08-15T18:30:00.000Z");
  assert.equal(
    isPrintWindowOpen({
      dayDate: "2026-08-16",
      printingOpen: true,
      now,
    }),
    true,
  );
  assert.equal(ucs2SegmentCount("न".repeat(SMS_UCS2_SINGLE)), 1);
  const sms = fillRegistrationSms({
    regNo: 12,
    dayDate: "2026-08-16",
    venue: "सीकर",
  });
  assert.match(sms, /12/);
  assert.doesNotMatch(sms, /https?:\/\//);
  assert.equal(
    pickEarliestFreeOtDay([
      { id: "a", dayDate: "2026-08-19", seatLimit: 1, seatsTaken: 0 },
    ])?.id,
    "a",
  );
  assert.ok(lineDecisions("ot").includes("deferred"));
});
