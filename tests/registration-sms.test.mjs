/**
 * Registration SMS template + non-blocking dispatch (#51).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  REGISTRATION_SMS_DLT_TEMPLATE,
  REGISTRATION_SMS_VAR_ORDER,
  fillRegistrationSms,
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
  assert.ok(REGISTRATION_SMS_DLT_TEMPLATE.includes("पंजीकरण"));
  assert.ok(REGISTRATION_SMS_DLT_TEMPLATE.includes("पर्ची"));
  assert.doesNotMatch(REGISTRATION_SMS_DLT_TEMPLATE, /https?:\/\//);
});

test("max-length rendered registration SMS stays within UCS-2 segment cap", () => {
  const inputs = maxLengthRegistrationInputs();
  const text = fillRegistrationSms(inputs);
  assert.match(text, /999999/);
  assert.match(text, /आएं/);
  assert.doesNotMatch(text, /https?:\/\//);
});

test("Devanagari venue is kept and the message is link-free", () => {
  const filled = fillRegistrationSms({
    regNo: 1001,
    dayDate: "2026-07-26",
    venue: "Hall—Main",
  });
  assert.ok(filled.includes("Hall"));
  assert.doesNotMatch(filled, /https?:\/\//);
});

test("venue truncation never cuts a Devanagari grapheme cluster", () => {
  const venue = "श्री रामकृष्ण नेत्र चिकित्सालय एवं अनुसंधान केन्द्र";
  const cut = truncateVenueForSms(venue);
  const segmenter = new Intl.Segmenter("hi", { granularity: "grapheme" });
  const graphemes = (value) =>
    [...segmenter.segment(value)].map((entry) => entry.segment);
  const cutGraphemes = graphemes(cut);
  assert.ok(cut.length <= 35);
  assert.ok(cutGraphemes.length > 0);
  assert.deepEqual(
    cutGraphemes,
    graphemes(venue).slice(0, cutGraphemes.length),
  );
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
      },
      {
        send: async () => {
          throw new Error("MSG91 down");
        },
      },
    );
    // Throw after dispatch starts is ambiguous (at-most-one; #65).
    assert.equal(result.status, "ambiguous");
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
    printTarget: {
      acquired: true,
      navigate: () => {
        printed = true;
        return true;
      },
      abandon: () => {},
    },
    resetForm: () => {},
    rotateAttempt: () => {},
    afterRegister: async () => {
      throw new Error("SMS adapter exploded");
    },
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.row.reg_no, 42);
  assert.equal(printed, true);
});

test("venue is truncated to keep one segment", () => {
  const long = "क".repeat(80);
  const cut = truncateVenueForSms(long);
  assert.ok([...cut].length <= 35);
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
