/**
 * Day-before reminder SMS (#52) — template, eligibility, send-once, non-throw.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  REMINDER_SMS_DLT_TEMPLATE,
  REMINDER_SMS_VAR_ORDER,
  createReminderJobStore,
  fillReminderSms,
  isMsg91ReminderConfigured,
  isReminderEligible,
  kolkataDateIso,
  maxLengthReminderInputs,
  runDayBeforeReminders,
  sendReminderSms,
} from "../src/lib/reminder-sms.ts";
import {
  listSmsFailures,
  resetSmsFailuresForTests,
} from "../src/lib/registration-sms.ts";

test("DLT reminder template is fixed with {#var#} slots in order", () => {
  assert.equal(
    (REMINDER_SMS_DLT_TEMPLATE.match(/\{#var#\}/g) || []).length,
    REMINDER_SMS_VAR_ORDER.length,
  );
  assert.ok(REMINDER_SMS_DLT_TEMPLATE.includes("स्मरण"));
  assert.ok(REMINDER_SMS_DLT_TEMPLATE.includes("आएं"));
  assert.doesNotMatch(REMINDER_SMS_DLT_TEMPLATE, /https?:\/\//);
});

test("max-length rendered reminder SMS is Devanagari and link-free", () => {
  const text = fillReminderSms(maxLengthReminderInputs());
  assert.match(text, /999999/);
  assert.match(text, /आएं/);
  assert.ok(!text.includes("http"));
});

test("kolkataDateIso anchors tomorrow in Asia/Kolkata", () => {
  // 2026-07-26 20:00 UTC = 2026-07-27 01:30 IST → today IST is 27th
  const eveningUtc = new Date("2026-07-26T20:00:00.000Z");
  assert.equal(kolkataDateIso(0, eveningUtc), "2026-07-27");
  assert.equal(kolkataDateIso(1, eveningUtc), "2026-07-28");

  // 2026-07-26 18:00 UTC = 2026-07-26 23:30 IST → still 26th
  const lateIst = new Date("2026-07-26T18:00:00.000Z");
  assert.equal(kolkataDateIso(0, lateIst), "2026-07-26");
  assert.equal(kolkataDateIso(1, lateIst), "2026-07-27");
});

test("eligibility: only registered + phone + tomorrow + not yet sent", () => {
  const tomorrow = "2026-07-27";
  const base = {
    id: "p1",
    regNo: 1001,
    phone: "9876543210",
    queueStatus: "registered",
    dayDate: tomorrow,
    venue: "Hall",
    reminderSmsSentAt: null,
  };
  assert.equal(isReminderEligible(base, tomorrow), true);
  assert.equal(
    isReminderEligible({ ...base, queueStatus: "waiting" }, tomorrow),
    false,
  );
  assert.equal(
    isReminderEligible({ ...base, queueStatus: "seen" }, tomorrow),
    false,
  );
  assert.equal(
    isReminderEligible({ ...base, phone: null }, tomorrow),
    false,
  );
  assert.equal(
    isReminderEligible({ ...base, dayDate: "2026-07-28" }, tomorrow),
    false,
  );
  assert.equal(
    isReminderEligible(
      { ...base, reminderSmsSentAt: "2026-07-26T02:30:00Z" },
      tomorrow,
    ),
    false,
  );
});

test("no phone skips send and is not an error", async () => {
  resetSmsFailuresForTests();
  let called = 0;
  const result = await sendReminderSms(
    { phone: null, regNo: 1, dayDate: "2026-07-27", venue: "H" },
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

test("provider failure does not throw from send or job", async () => {
  resetSmsFailuresForTests();
  process.env.MSG91_AUTH_KEY = "k";
  process.env.MSG91_SENDER_ID = "SNPCP";
  process.env.MSG91_TEMPLATE_REMINDER = "tpl-rem";
  try {
    const result = await sendReminderSms(
      {
        phone: "+919876543210",
        regNo: 12,
        dayDate: "2026-07-27",
        venue: "Hall",
      },
      {
        send: async () => {
          throw new Error("MSG91 down");
        },
      },
    );
    // Throw/timeout after dispatch starts → ambiguous (not auto-retried).
    assert.equal(result.status, "ambiguous");
    assert.match(listSmsFailures()[0].detail, /MSG91 down/);

    /** @type {Map<string, string>} */
    const states = new Map();
    const summary = await runDayBeforeReminders({
      now: new Date("2026-07-26T03:00:00.000Z"), // tomorrow IST = 2026-07-27
      preFiltered: false,
      listCandidates: async () => [
        {
          id: "p1",
          regNo: 12,
          phone: "9876543210",
          queueStatus: "registered",
          dayDate: "2026-07-27",
          venue: "Hall",
          reminderSmsSentAt: null,
        },
      ],
      claimReminder: async (id) => {
        if (states.get(id) === "sent" || states.get(id) === "ambiguous") {
          return null;
        }
        states.set(id, "sending");
        return { deliveryId: `d-${id}`, claimToken: `t-${id}` };
      },
      startReminder: async () => true,
      completeReminder: async ({ deliveryId, outcome }) => {
        const id = deliveryId.replace(/^d-/, "");
        states.set(id, outcome === "release" ? "pending" : outcome);
        return true;
      },
      send: async () => {
        throw new Error("provider outage");
      },
    });
    assert.equal(summary.ok, false);
    assert.equal(summary.ambiguous, 1);
    assert.equal(summary.sent, 0);
    // Ambiguous is not released for automatic retry.
    assert.equal(states.get("p1"), "ambiguous");
  } finally {
    delete process.env.MSG91_AUTH_KEY;
    delete process.env.MSG91_SENDER_ID;
    delete process.env.MSG91_TEMPLATE_REMINDER;
    resetSmsFailuresForTests();
  }
});

test("running the job twice sends exactly once per patient", async () => {
  process.env.MSG91_AUTH_KEY = "k";
  process.env.MSG91_SENDER_ID = "SNPCP";
  process.env.MSG91_TEMPLATE_REMINDER = "tpl-rem";
  try {
    /** @type {Map<string, string | null>} */
    const states = new Map([["p1", null], ["p2", null]]);
    let sendCalls = 0;

    const candidates = () =>
      Promise.resolve(
        [
          {
            id: "p1",
            regNo: 1001,
            phone: "9876543210",
            queueStatus: "registered",
            dayDate: "2026-07-27",
            venue: "Hall A",
            reminderDeliveryState: states.get("p1"),
          },
          {
            id: "p2",
            regNo: 1002,
            phone: "9876543211",
            queueStatus: "waiting", // already checked in — never
            dayDate: "2026-07-27",
            venue: "Hall A",
            reminderDeliveryState: states.get("p2"),
          },
        ],
      );

    const deps = {
      now: new Date("2026-07-26T03:00:00.000Z"),
      preFiltered: false,
      listCandidates: candidates,
      claimReminder: async (id) => {
        const st = states.get(id);
        if (st === "sent" || st === "ambiguous" || st === "sending") return null;
        states.set(id, "sending");
        return { deliveryId: `d-${id}`, claimToken: `t-${id}` };
      },
      startReminder: async () => true,
      completeReminder: async ({ deliveryId, outcome }) => {
        const id = deliveryId.replace(/^d-/, "");
        states.set(id, outcome === "release" ? "pending" : outcome);
        return true;
      },
      send: async () => {
        sendCalls += 1;
        return { ok: true, requestId: `r-${sendCalls}` };
      },
    };

    const first = await runDayBeforeReminders(deps);
    const second = await runDayBeforeReminders(deps);

    assert.equal(first.sent, 1);
    assert.equal(second.sent, 0);
    assert.equal(sendCalls, 1);
    assert.equal(states.get("p1"), "sent");
    assert.equal(states.get("p2"), null);
  } finally {
    delete process.env.MSG91_AUTH_KEY;
    delete process.env.MSG91_SENDER_ID;
    delete process.env.MSG91_TEMPLATE_REMINDER;
  }
});

test("provider success plus ledger-completion failure is truthful ambiguity", async () => {
  process.env.MSG91_AUTH_KEY = "k";
  process.env.MSG91_SENDER_ID = "SNPCP";
  process.env.MSG91_TEMPLATE_REMINDER = "tpl-rem";
  try {
    const summary = await runDayBeforeReminders({
      now: new Date("2026-07-26T03:00:00.000Z"),
      preFiltered: false,
      listCandidates: async () => [
        {
          id: "p-ledger-fail",
          regNo: 1003,
          phone: "9876543212",
          queueStatus: "registered",
          dayDate: "2026-07-27",
          venue: "Hall",
        },
      ],
      claimReminder: async () => ({
        deliveryId: "d-ledger-fail",
        claimToken: "t-ledger-fail",
      }),
      startReminder: async () => true,
      completeReminder: async () => false,
      send: async () => ({ ok: true, requestId: "provider-accepted" }),
    });

    assert.equal(summary.sent, 0);
    assert.equal(summary.ambiguous, 1);
    assert.equal(summary.ok, false);
    assert.match(String(summary.error), /ledger confirmation/i);
  } finally {
    delete process.env.MSG91_AUTH_KEY;
    delete process.env.MSG91_SENDER_ID;
    delete process.env.MSG91_TEMPLATE_REMINDER;
  }
});

test("listCandidates failure marks job ok:false", async () => {
  const summary = await runDayBeforeReminders({
    now: new Date("2026-07-26T03:00:00.000Z"),
    listCandidates: async () => {
      throw new Error("schema missing");
    },
    claimReminder: async () => null,
    completeReminder: async () => {},
  });
  assert.equal(summary.ok, false);
  assert.match(String(summary.error), /schema missing/);
  assert.equal(summary.sent, 0);
});

test("claim failure makes the reminder job unsuccessful before dispatch", async () => {
  let sent = false;
  const summary = await runDayBeforeReminders({
    now: new Date("2026-07-26T03:00:00.000Z"),
    preFiltered: false,
    listCandidates: async () => [
      {
        id: "claim-failure",
        regNo: 1101,
        phone: "9876543210",
        queueStatus: "registered",
        dayDate: "2026-07-27",
        venue: "Hall",
      },
    ],
    claimReminder: async () => {
      throw new Error("claim unavailable");
    },
    startReminder: async () => true,
    completeReminder: async () => true,
    send: async () => {
      sent = true;
      return { ok: true };
    },
  });

  assert.equal(summary.ok, false);
  assert.equal(summary.failed, 1);
  assert.equal(summary.sent, 0);
  assert.equal(sent, false);
});

test("dispatch-start failure releases the claim and makes the job unsuccessful", async () => {
  const completions = [];
  const summary = await runDayBeforeReminders({
    now: new Date("2026-07-26T03:00:00.000Z"),
    preFiltered: false,
    listCandidates: async () => [
      {
        id: "start-failure",
        regNo: 1102,
        phone: "9876543211",
        queueStatus: "registered",
        dayDate: "2026-07-27",
        venue: "Hall",
      },
    ],
    claimReminder: async () => ({
      deliveryId: "delivery-start",
      claimToken: "token-start",
    }),
    startReminder: async () => false,
    completeReminder: async (input) => {
      completions.push(input);
      return true;
    },
  });

  assert.equal(summary.ok, false);
  assert.equal(summary.failed, 1);
  assert.deepEqual(completions.map((row) => row.outcome), ["release"]);
});

test("provider rejection makes the reminder job unsuccessful", async () => {
  const previous = {
    key: process.env.MSG91_AUTH_KEY,
    sender: process.env.MSG91_SENDER_ID,
    template: process.env.MSG91_TEMPLATE_REMINDER,
  };
  process.env.MSG91_AUTH_KEY = "key";
  process.env.MSG91_SENDER_ID = "SNPCMP";
  process.env.MSG91_TEMPLATE_REMINDER = "reminder-template";
  const completions = [];
  try {
    const summary = await runDayBeforeReminders({
      now: new Date("2026-07-26T03:00:00.000Z"),
      preFiltered: false,
      listCandidates: async () => [
        {
          id: "provider-failure",
          regNo: 1103,
          phone: "9876543212",
          queueStatus: "registered",
          dayDate: "2026-07-27",
          venue: "Hall",
        },
      ],
      claimReminder: async () => ({
        deliveryId: "delivery-provider",
        claimToken: "token-provider",
      }),
      startReminder: async () => true,
      completeReminder: async (input) => {
        completions.push(input);
        return true;
      },
      send: async () => ({
        ok: false,
        detail: "provider rejected request",
        failureKind: "rejected",
      }),
    });

    assert.equal(summary.ok, false);
    assert.equal(summary.failed, 1);
    assert.equal(summary.ambiguous, 0);
    assert.deepEqual(completions.map((row) => row.outcome), ["failed"]);
  } finally {
    if (previous.key === undefined) delete process.env.MSG91_AUTH_KEY;
    else process.env.MSG91_AUTH_KEY = previous.key;
    if (previous.sender === undefined) delete process.env.MSG91_SENDER_ID;
    else process.env.MSG91_SENDER_ID = previous.sender;
    if (previous.template === undefined) delete process.env.MSG91_TEMPLATE_REMINDER;
    else process.env.MSG91_TEMPLATE_REMINDER = previous.template;
  }
});

test("mixed reminder batch preserves exact sent, skipped, failed, and ambiguous counts", async () => {
  const previous = {
    key: process.env.MSG91_AUTH_KEY,
    sender: process.env.MSG91_SENDER_ID,
    template: process.env.MSG91_TEMPLATE_REMINDER,
  };
  process.env.MSG91_AUTH_KEY = "key";
  process.env.MSG91_SENDER_ID = "SNPCMP";
  process.env.MSG91_TEMPLATE_REMINDER = "reminder-template";
  const providerResults = [
    { ok: true, requestId: "sent-1" },
    { ok: false, detail: "rejected", failureKind: "rejected" },
  ];
  try {
    const summary = await runDayBeforeReminders({
      now: new Date("2026-07-26T03:00:00.000Z"),
      preFiltered: false,
      listCandidates: async () => [
        ["sent", 1201, "9876543201", "registered"],
        ["failed", 1202, "9876543202", "registered"],
        ["ambiguous", 1203, "9876543203", "registered"],
        ["skipped", 1204, "9876543204", "seen"],
      ].map(([id, regNo, phone, queueStatus]) => ({
        id,
        regNo,
        phone,
        queueStatus,
        dayDate: "2026-07-27",
        venue: "Hall",
      })),
      claimReminder: async (id) => ({
        deliveryId: `delivery-${id}`,
        claimToken: `token-${id}`,
      }),
      startReminder: async () => true,
      completeReminder: async () => true,
      send: async () => {
        if (providerResults.length === 0) throw new Error("fetch failed");
        return providerResults.shift();
      },
    });

    assert.equal(summary.ok, false);
    assert.deepEqual(
      {
        sent: summary.sent,
        skipped: summary.skipped,
        failed: summary.failed,
        ambiguous: summary.ambiguous,
      },
      { sent: 1, skipped: 1, failed: 1, ambiguous: 1 },
    );
  } finally {
    if (previous.key === undefined) delete process.env.MSG91_AUTH_KEY;
    else process.env.MSG91_AUTH_KEY = previous.key;
    if (previous.sender === undefined) delete process.env.MSG91_SENDER_ID;
    else process.env.MSG91_SENDER_ID = previous.sender;
    if (previous.template === undefined) delete process.env.MSG91_TEMPLATE_REMINDER;
    else process.env.MSG91_TEMPLATE_REMINDER = previous.template;
  }
});

test("reminder candidate selection excludes an inactive Camp", async () => {
  let activeOnly = false;
  const inactivePatient = {
    id: "inactive-patient",
    reg_no: 1301,
    phone: "9876543205",
    queue_status: "registered",
    reminder_sms_sent_at: null,
    camp_days: { day_date: "2026-07-27" },
    camps: { venue: "Cancelled Hall", is_active: false },
  };
  const query = {
    select() {
      return this;
    },
    eq(column, value) {
      if (column === "camps.is_active") {
        activeOnly = value === true;
        return Promise.resolve({
          data: activeOnly ? [] : [inactivePatient],
          error: null,
        });
      }
      return this;
    },
    not() {
      return this;
    },
  };
  const store = createReminderJobStore({
    from: () => query,
    rpc: async () => ({ data: null, error: null }),
  });

  assert.deepEqual(await store.listCandidates(), []);
  assert.equal(activeOnly, true);
});

test("isMsg91ReminderConfigured requires reminder template id", () => {
  const prev = {
    k: process.env.MSG91_AUTH_KEY,
    s: process.env.MSG91_SENDER_ID,
    r: process.env.MSG91_TEMPLATE_REMINDER,
    reg: process.env.MSG91_TEMPLATE_REGISTRATION,
  };
  try {
    process.env.MSG91_AUTH_KEY = "k";
    process.env.MSG91_SENDER_ID = "SNPCP";
    process.env.MSG91_TEMPLATE_REGISTRATION = "tpl-reg";
    delete process.env.MSG91_TEMPLATE_REMINDER;
    assert.equal(isMsg91ReminderConfigured(), false);
    process.env.MSG91_TEMPLATE_REMINDER = "tpl-rem";
    assert.equal(isMsg91ReminderConfigured(), true);
  } finally {
    if (prev.k === undefined) delete process.env.MSG91_AUTH_KEY;
    else process.env.MSG91_AUTH_KEY = prev.k;
    if (prev.s === undefined) delete process.env.MSG91_SENDER_ID;
    else process.env.MSG91_SENDER_ID = prev.s;
    if (prev.r === undefined) delete process.env.MSG91_TEMPLATE_REMINDER;
    else process.env.MSG91_TEMPLATE_REMINDER = prev.r;
    if (prev.reg === undefined) delete process.env.MSG91_TEMPLATE_REGISTRATION;
    else process.env.MSG91_TEMPLATE_REGISTRATION = prev.reg;
  }
});
