import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFERRAL_SERVICE_OT,
  DEFERRAL_SERVICE_SPECS,
  deferralIssueKind,
  deferralT1Kind,
  fillDeferralSms,
  sendDeferralSms,
} from "../src/lib/deferral-sms.ts";

const PREV_ENV = {
  key: process.env.MSG91_AUTH_KEY,
  sender: process.env.MSG91_SENDER_ID,
  tpl: process.env.MSG91_TEMPLATE_DEFERRAL,
};

test.before(() => {
  process.env.MSG91_AUTH_KEY = "key";
  process.env.MSG91_SENDER_ID = "SNPCMP";
  process.env.MSG91_TEMPLATE_DEFERRAL = "tpl-def";
});

test.after(() => {
  if (PREV_ENV.key === undefined) delete process.env.MSG91_AUTH_KEY;
  else process.env.MSG91_AUTH_KEY = PREV_ENV.key;
  if (PREV_ENV.sender === undefined) delete process.env.MSG91_SENDER_ID;
  else process.env.MSG91_SENDER_ID = PREV_ENV.sender;
  if (PREV_ENV.tpl === undefined) delete process.env.MSG91_TEMPLATE_DEFERRAL;
  else process.env.MSG91_TEMPLATE_DEFERRAL = PREV_ENV.tpl;
});

test("a deferral with no ledger claim is skipped rather than sent unledgered", async () => {
  let sent = 0;
  const send = async () => {
    sent += 1;
    return { ok: true };
  };
  const noPatient = await sendDeferralSms(
    {
      phone: "+919876543210",
      service: DEFERRAL_SERVICE_SPECS,
      dayDate: "2026-08-20",
      venue: "सीकर",
      patientId: undefined,
      kind: deferralT1Kind("specs"),
    },
    { send, ledger: { rpc: async () => ({ data: null, error: null }) } },
  );
  assert.equal(noPatient.status, "skipped");
  assert.equal(noPatient.reason, "not_claimed");

  const noLedger = await sendDeferralSms(
    {
      phone: "+919876543210",
      service: DEFERRAL_SERVICE_SPECS,
      dayDate: "2026-08-20",
      venue: "सीकर",
      patientId: "11111111-1111-1111-1111-111111111111",
      kind: deferralT1Kind("specs"),
    },
    { send },
  );
  assert.equal(noLedger.status, "skipped");
  assert.equal(noLedger.reason, "not_claimed");
  assert.equal(sent, 0);
});

test("an unconfigured deferral template refuses even with an injected sender", async () => {
  const tpl = process.env.MSG91_TEMPLATE_DEFERRAL;
  delete process.env.MSG91_TEMPLATE_DEFERRAL;
  let sent = 0;
  try {
    const result = await sendDeferralSms(
      {
        phone: "+919876543210",
        service: DEFERRAL_SERVICE_SPECS,
        dayDate: "2026-08-20",
        venue: "सीकर",
        patientId: "11111111-1111-1111-1111-111111111111",
        kind: deferralIssueKind("specs"),
      },
      {
        send: async () => {
          sent += 1;
          return { ok: true };
        },
        ledger: { rpc: async () => ({ data: null, error: null }) },
      },
    );
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "unconfigured");
    assert.equal(sent, 0);
  } finally {
    process.env.MSG91_TEMPLATE_DEFERRAL = tpl;
  }
});

test("issue and T-1 kinds differ so unique (patient_id, kind) allows both sends", () => {
  assert.equal(deferralIssueKind("specs"), "spectacles_deferral");
  assert.equal(deferralIssueKind("ot"), "surgery_deferral");
  assert.equal(deferralT1Kind("specs"), "spectacles_deferral_t1");
  assert.equal(deferralT1Kind("ot"), "surgery_deferral_t1");
  assert.notEqual(deferralIssueKind("specs"), deferralT1Kind("specs"));
  assert.notEqual(deferralIssueKind("ot"), deferralT1Kind("ot"));
  assert.notEqual(deferralIssueKind("specs"), deferralIssueKind("ot"));
});

test("sendDeferralSms skips without a phone and without claiming", async () => {
  let claimed = false;
  const result = await sendDeferralSms(
    {
      phone: null,
      service: DEFERRAL_SERVICE_SPECS,
      dayDate: "2026-08-20",
      venue: "सीकर",
      patientId: "11111111-1111-1111-1111-111111111111",
      kind: deferralIssueKind("specs"),
    },
    {
      ledger: {
        rpc: async () => {
          claimed = true;
          return { data: null, error: null };
        },
      },
    },
  );
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "no_phone");
  assert.equal(claimed, false);
});

test("sendDeferralSms claims the given kind then completes sent", async () => {
  const calls = [];
  const result = await sendDeferralSms(
    {
      phone: "+919876543210",
      service: DEFERRAL_SERVICE_OT,
      dayDate: "2026-08-21",
      venue: "सीकर",
      patientId: "11111111-1111-1111-1111-111111111111",
      kind: deferralT1Kind("ot"),
    },
    {
      send: async () => ({ ok: true, requestId: "req-1" }),
      ledger: {
        rpc: async (fn, args) => {
          calls.push({ fn, args });
          if (fn === "claim_sms_delivery") {
            return {
              data: { delivery_id: "d1", claim_token: "t1" },
              error: null,
            };
          }
          return { data: true, error: null };
        },
      },
    },
  );
  assert.equal(result.status, "sent");
  assert.equal(calls[0].fn, "claim_sms_delivery");
  assert.equal(calls[0].args.p_kind, "surgery_deferral_t1");
  assert.ok(calls.some((c) => c.fn === "complete_sms_delivery"));
  assert.doesNotMatch(
    fillDeferralSms({
      service: DEFERRAL_SERVICE_OT,
      dayDate: "2026-08-21",
      venue: "सीकर",
    }),
    /https?:\/\//,
  );
});
