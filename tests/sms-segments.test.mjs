import assert from "node:assert/strict";
import test from "node:test";
import {
  SMS_MAX_SEGMENTS,
  SMS_UCS2_CONCAT,
  SMS_UCS2_SINGLE,
  assertSmsSegments,
  ucs2SegmentCount,
} from "../src/lib/sms-segments.ts";
import { formatCampDaySms } from "../src/lib/format-camp-day.ts";
import {
  DEVANAGARI_VENUE_FALLBACK,
  fillRegistrationSms,
  REGISTRATION_SMS_DLT_TEMPLATE,
  REGISTRATION_SMS_VAR_ORDER,
  sendRegistrationSms,
  truncateVenueForSms,
} from "../src/lib/registration-sms.ts";
import {
  fillReminderSms,
  REMINDER_SMS_DLT_TEMPLATE,
  REMINDER_SMS_VAR_ORDER,
} from "../src/lib/reminder-sms.ts";
import {
  DEFERRAL_SERVICE_OT,
  DEFERRAL_SERVICE_SPECS,
  fillDeferralSms,
} from "../src/lib/deferral-sms.ts";

test("UCS-2 single segment is 70 characters", () => {
  assert.equal(SMS_UCS2_SINGLE, 70);
  assert.equal(ucs2SegmentCount("न".repeat(70)), 1);
  assert.equal(ucs2SegmentCount("न".repeat(71)), 2);
});

test("UCS-2 concatenated segments are 67 characters each", () => {
  assert.equal(SMS_UCS2_CONCAT, 67);
  assert.equal(ucs2SegmentCount("न".repeat(71)), 2);
  assert.equal(ucs2SegmentCount("न".repeat(134)), 2);
  assert.equal(ucs2SegmentCount("न".repeat(135)), 3);
});

test("send is refused above the exported max-segment constant", () => {
  assert.equal(SMS_MAX_SEGMENTS, 3);
  const tooLong = "न".repeat(SMS_UCS2_CONCAT * SMS_MAX_SEGMENTS + 1);
  assert.throws(() => assertSmsSegments(tooLong), /SMS_SEGMENTS_EXCEEDED/);
  assert.equal(
    assertSmsSegments("न".repeat(SMS_UCS2_CONCAT * SMS_MAX_SEGMENTS)),
    "न".repeat(SMS_UCS2_CONCAT * SMS_MAX_SEGMENTS),
  );
});

test("the send path refuses a message above the segment cap", async () => {
  const prev = {
    key: process.env.MSG91_AUTH_KEY,
    sender: process.env.MSG91_SENDER_ID,
    tpl: process.env.MSG91_TEMPLATE_REGISTRATION,
  };
  process.env.MSG91_AUTH_KEY = "key";
  process.env.MSG91_SENDER_ID = "SNPCMP";
  process.env.MSG91_TEMPLATE_REGISTRATION = "tpl-reg";
  let sent = 0;
  try {
    const result = await sendRegistrationSms(
      {
        phone: "+919876543210",
        regNo: 12,
        dayDate: "न".repeat(300),
        venue: "सीकर",
      },
      {
        send: async () => {
          sent += 1;
          return { ok: true };
        },
      },
    );
    assert.equal(result.status, "failed");
    assert.match(result.detail, /SMS_SEGMENTS_EXCEEDED/);
    assert.equal(sent, 0);
  } finally {
    if (prev.key === undefined) delete process.env.MSG91_AUTH_KEY;
    else process.env.MSG91_AUTH_KEY = prev.key;
    if (prev.sender === undefined) delete process.env.MSG91_SENDER_ID;
    else process.env.MSG91_SENDER_ID = prev.sender;
    if (prev.tpl === undefined) delete process.env.MSG91_TEMPLATE_REGISTRATION;
    else process.env.MSG91_TEMPLATE_REGISTRATION = prev.tpl;
  }
});

test("Devanagari venue truncation does not strip script and empty falls back", () => {
  const long = "नेत्र".repeat(20);
  const cut = truncateVenueForSms(long);
  assert.ok(cut.includes("ने"));
  assert.ok([...cut].length <= 35);
  assert.equal(truncateVenueForSms(""), DEVANAGARI_VENUE_FALLBACK);
  assert.equal(truncateVenueForSms("   "), DEVANAGARI_VENUE_FALLBACK);
});

test("Devanagari months keep ASCII digits; malformed input passes through", () => {
  assert.equal(formatCampDaySms("2026-01-15"), "15 जनवरी 2026");
  assert.equal(formatCampDaySms("2026-08-16"), "16 अगस्त 2026");
  assert.equal(formatCampDaySms("2026-12-01"), "1 दिसंबर 2026");
  assert.equal(formatCampDaySms("not-a-date"), "not-a-date");
});

test("registration template is Devanagari, link-free, and matches var order", () => {
  assert.equal(
    (REGISTRATION_SMS_DLT_TEMPLATE.match(/\{#var#\}/g) || []).length,
    REGISTRATION_SMS_VAR_ORDER.length,
  );
  assert.deepEqual([...REGISTRATION_SMS_VAR_ORDER], ["reg", "date", "venue"]);
  const text = fillRegistrationSms({
    regNo: 87,
    dayDate: "2026-08-16",
    venue: "सीकर",
  });
  assert.match(text, /87/);
  assert.match(text, /16 अगस्त 2026/);
  assert.match(text, /सीकर/);
  assert.doesNotMatch(text, /https?:\/\//);
});

test("reminder and deferral templates are Devanagari and link-free", () => {
  assert.equal(
    (REMINDER_SMS_DLT_TEMPLATE.match(/\{#var#\}/g) || []).length,
    REMINDER_SMS_VAR_ORDER.length,
  );
  const reminder = fillReminderSms({
    regNo: 87,
    dayDate: "2026-08-16",
    venue: "सीकर",
  });
  assert.doesNotMatch(reminder, /https?:\/\//);
  const deferral = fillDeferralSms({
    service: DEFERRAL_SERVICE_SPECS,
    dayDate: "2026-08-20",
    venue: "सीकर",
  });
  assert.match(deferral, new RegExp(DEFERRAL_SERVICE_SPECS));
  assert.match(fillDeferralSms({
    service: DEFERRAL_SERVICE_OT,
    dayDate: "2026-08-20",
    venue: "सीकर",
  }), new RegExp(DEFERRAL_SERVICE_OT));
  assert.doesNotMatch(deferral, /https?:\/\//);
});
