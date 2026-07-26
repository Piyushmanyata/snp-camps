/**
 * Registration SMS template + non-blocking dispatch (#51).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  REGISTRATION_SMS_DLT_TEMPLATE,
  REGISTRATION_SMS_VAR_ORDER,
  assertGsm7,
  fillRegistrationSms,
  isGsm7,
  isMsg91Configured,
  listSmsFailures,
  maxLengthRegistrationInputs,
  recordSmsFailure,
  resetSmsFailuresForTests,
  sendRegistrationSms,
  truncateVenueForSms,
} from "../src/lib/registration-sms.ts";
import { createRegistrationAttempt } from "../src/lib/registration-request.ts";
import { runDeskRegisterAndPrint } from "../src/lib/desk-register-flow.ts";

test("DLT template is a fixed constant with {#var#} slots in order", () => {
  assert.match(REGISTRATION_SMS_DLT_TEMPLATE, /\{#var#\}/);
  assert.equal(
    (REGISTRATION_SMS_DLT_TEMPLATE.match(/\{#var#\}/g) || []).length,
    REGISTRATION_SMS_VAR_ORDER.length,
  );
  // Must not be free-form English assembly of whole sentences at runtime.
  assert.ok(REGISTRATION_SMS_DLT_TEMPLATE.includes("Reg #"));
  assert.ok(REGISTRATION_SMS_DLT_TEMPLATE.includes("Slip rakhein"));
});

test("max-length rendered registration SMS is <=160 GSM-7 chars", () => {
  const inputs = maxLengthRegistrationInputs();
  const text = fillRegistrationSms(inputs);
  assert.ok(isGsm7(text), `non-GSM-7 in message: ${JSON.stringify(text)}`);
  assert.ok(
    text.length <= 160,
    `message length ${text.length} > 160: ${JSON.stringify(text)}`,
  );
  // Useful without the link (button phone cannot open it).
  assert.match(text, /Reg #\d+/);
  assert.match(text, /pe aana/);
  assert.match(text, /Slip rakhein/);
});

test("non-GSM-7 characters cannot enter the message", () => {
  // Venue strips en-dash / curly junk; filled body stays GSM-7.
  const stripped = fillRegistrationSms({
    regNo: 1001,
    dayDate: "2026-07-26",
    venue: "Hall—Main", // en-dash stripped
    statusUrl: "https://example.com/s/abc",
  });
  assert.equal(isGsm7(stripped), true);
  assert.ok(!stripped.includes("—"));
  // Link / date slots must not accept non-GSM-7 (would force Unicode SMS).
  assert.throws(
    () =>
      fillRegistrationSms({
        regNo: 1001,
        dayDate: "2026-07-26",
        venue: "Hall",
        statusUrl: "https://example.com/s/🙂",
      }),
    /GSM-7/,
  );
  assert.equal(assertGsm7("plain ASCII ok"), "plain ASCII ok");
});

test("no phone skips send, records no failure", async () => {
  resetSmsFailuresForTests();
  let called = 0;
  const result = await sendRegistrationSms(
    {
      phone: null,
      regNo: 12,
      dayDate: "2026-07-26",
      venue: "Hall",
      statusUrl: "https://example.com/s/tok",
    },
    {
      send: async () => {
        called += 1;
        return { ok: true };
      },
    },
  );
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "no_phone");
  assert.equal(called, 0);
  assert.equal(listSmsFailures().length, 0);
});

test("unconfigured provider skips without failing", async () => {
  resetSmsFailuresForTests();
  const prev = {
    key: process.env.MSG91_AUTH_KEY,
    sender: process.env.MSG91_SENDER_ID,
    tpl: process.env.MSG91_TEMPLATE_REGISTRATION,
  };
  delete process.env.MSG91_AUTH_KEY;
  delete process.env.MSG91_SENDER_ID;
  delete process.env.MSG91_TEMPLATE_REGISTRATION;
  try {
    assert.equal(isMsg91Configured(), false);
    let called = 0;
    const result = await sendRegistrationSms(
      {
        phone: "9876543210",
        regNo: 12,
        dayDate: "2026-07-26",
        venue: "Hall",
        statusUrl: "https://example.com/s/tok",
      },
      {
        send: async () => {
          called += 1;
          return { ok: true };
        },
      },
    );
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "unconfigured");
    assert.equal(called, 0);
    assert.equal(listSmsFailures().length, 0);
  } finally {
    if (prev.key === undefined) delete process.env.MSG91_AUTH_KEY;
    else process.env.MSG91_AUTH_KEY = prev.key;
    if (prev.sender === undefined) delete process.env.MSG91_SENDER_ID;
    else process.env.MSG91_SENDER_ID = prev.sender;
    if (prev.tpl === undefined) delete process.env.MSG91_TEMPLATE_REGISTRATION;
    else process.env.MSG91_TEMPLATE_REGISTRATION = prev.tpl;
  }
});

test("provider throw is recorded and does not throw to caller", async () => {
  resetSmsFailuresForTests();
  process.env.MSG91_AUTH_KEY = "test-key";
  process.env.MSG91_SENDER_ID = "SNPCP";
  process.env.MSG91_TEMPLATE_REGISTRATION = "tpl-reg";
  try {
    const result = await sendRegistrationSms(
      {
        phone: "+919876543210",
        regNo: 12,
        dayDate: "2026-07-26",
        venue: "Hall",
        statusUrl: "https://example.com/s/tok",
      },
      {
        send: async () => {
          throw new Error("MSG91 down");
        },
      },
    );
    assert.equal(result.status, "failed");
    const fails = listSmsFailures();
    assert.equal(fails.length, 1);
    assert.match(fails[0].detail, /MSG91 down/);
    assert.equal(fails[0].template, "registration");
  } finally {
    delete process.env.MSG91_AUTH_KEY;
    delete process.env.MSG91_SENDER_ID;
    delete process.env.MSG91_TEMPLATE_REGISTRATION;
    resetSmsFailuresForTests();
  }
});

test("provider failure does not fail desk registration", async () => {
  const staffFields = {
    campId: "11111111-1111-4111-8111-111111111111",
    fullName: "Test Patient",
    gender: null,
    age: 30,
    address: null,
    phone: "9876543210",
    email: null,
    aadhaarLast4: null,
    userId: null,
    createdBy: "44444444-4444-4444-8444-444444444444",
    campDayId: "22222222-2222-4222-8222-222222222222",
  };
  const attempt = createRegistrationAttempt(() => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  let printed = false;
  const outcome = await runDeskRegisterAndPrint({
    attempt,
    staffFields,
    rpc: async () => ({
      data: [
        {
          id: "p1",
          reg_no: 42,
          full_name: "Test Patient",
          queue_status: "registered",
        },
      ],
      error: null,
    }),
    openPrint: () => {
      printed = true;
    },
    resetForm: () => {},
    rotateAttempt: () => {},
    afterRegister: async () => {
      throw new Error("SMS adapter exploded");
    },
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.row.reg_no, 42);
  assert.equal(printed, true);
});

test("venue is truncated to keep one segment", () => {
  const long = "A".repeat(80);
  const cut = truncateVenueForSms(long);
  assert.ok(cut.length <= 35);
  assert.equal(isGsm7(cut), true);
});

test("recordSmsFailure keeps a bounded admin-visible log", () => {
  resetSmsFailuresForTests();
  for (let i = 0; i < 60; i++) {
    recordSmsFailure({ template: "registration", detail: `fail-${i}` });
  }
  const list = listSmsFailures();
  assert.ok(list.length <= 50);
  assert.equal(list[list.length - 1].detail, "fail-59");
});
