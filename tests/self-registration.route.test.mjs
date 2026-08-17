/**
 * Behavioural coverage for POST /api/self-registration (#113).
 *
 * The Aadhaar card scan replaced the eKYC OTP flow, so this route now accepts
 * scanned card fields directly from an unauthenticated patient. That makes it a
 * public write endpoint, and its validation is the only thing standing between
 * a mistyped form and a bad medical record — so assert the branches, not the
 * wiring.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../src/app/api/self-registration/route.ts";
import {
  __resetServiceRoleClient,
  __setServiceRoleClient,
} from "./stubs/service-role-admin.mjs";

const CAMP_ID = "11111111-1111-4111-8111-111111111111";
const DAY_ID = "22222222-2222-4222-8222-222222222222";
const PATIENT_ID = "33333333-3333-4333-8333-333333333333";
const DEFAULT_REQUEST_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const VALID_CARD = {
  fullName: "Ramesh Kumar",
  gender: "M",
  age: 50,
  address: "Sikar",
  aadhaarLast4: "9999",
  dateOfBirth: "1976-05-15",
};

/** The route derives the Person key itself, so the pepper must be present. */
process.env.AADHAAR_HASH_PEPPER ||= "test-pepper";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "self-registration-route-test-secret";
process.env.RATE_LIMIT_SECRET ||= "self-registration-rate-limit-secret";

/**
 * Minimal service-role fake. `rpcResult` decides what
 * register_patient_idempotent returns; every call is recorded so the arguments
 * the route sends can be asserted.
 */
function fakeSupabase(
  rpcResult,
  rateResult = { allowed: true, retry_after_seconds: 30 },
  options = {},
) {
  const calls = [];
  const statusToken = options.statusToken ?? "tok_abcdef";
  const existingByReg = options.existingByReg ?? null;
  return {
    calls,
    client: {
      rpc(fn, args) {
        calls.push({ fn, args });
        if (fn === "consume_public_rate_limit") {
          return Promise.resolve({ data: [rateResult], error: null });
        }
        return Promise.resolve(rpcResult);
      },
      from(table) {
        return {
          select() {
            const filters = [];
            const chain = {
              eq(col, value) {
                filters.push([col, value]);
                chain._eqValue = value;
                return chain;
              },
              order() {
                return chain;
              },
              limit() {
                return chain;
              },
              maybeSingle: () => {
                calls.push({ fn: `select:${table}`, filters });
                if (table === "patients" && existingByReg && chain._eqValue != null) {
                  const row = existingByReg[String(chain._eqValue)] ?? null;
                  return Promise.resolve({ error: null, data: row });
                }
                if (table === "camp_days") {
                  return Promise.resolve({
                    error: null,
                    data: { day_date: "2026-08-01" },
                  });
                }
                return Promise.resolve({
                  error: null,
                  data: { status_token: statusToken },
                });
              },
            };
            return chain;
          },
        };
      },
    },
  };
}

function post(body) {
  // A fresh IP per request keeps the per-instance rate limiter from bleeding
  // between cases.
  return POST(
    new Request("http://localhost/api/self-registration", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vercel-forwarded-for": `10.0.0.${Math.floor(Math.random() * 250) + 1}`,
      },
       body: JSON.stringify({ requestId: DEFAULT_REQUEST_ID, ...body }),
    }),
  );
}

const okRpc = {
  data: [{ id: PATIENT_ID, reg_no: 4242, camp_day_id: DAY_ID, day_date: "2026-08-01" }],
  error: null,
};

test.afterEach(() => {
  __resetServiceRoleClient();
});

test("a scanned card plus a typed phone registers and returns the receipt", async () => {
  const fake = fakeSupabase(okRpc);
  __setServiceRoleClient(fake.client);

  const response = await post({
    campId: CAMP_ID,
    campDayId: DAY_ID,
    phone: "9876543210",
    card: VALID_CARD,
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.registrationNumber, 4242);
  assert.equal(body.statusUrl, undefined);
  // Registering for today must still not put a patient in the hall queue.
  assert.equal(body.queueStatus, "registered");
});

test("self-service registration is flagged and carries a Person key, never an eKYC handle", async () => {
  const fake = fakeSupabase(okRpc);
  __setServiceRoleClient(fake.client);

  await post({ campId: CAMP_ID, campDayId: DAY_ID, phone: "9876543210", card: VALID_CARD });

  const { args } = fake.calls.find(
    (call) => call.fn === "register_patient_idempotent",
  );
  assert.equal(args.p_self_service, true);
  assert.equal(args.p_provenance, "card_scanned");
  assert.equal(typeof args.p_duplicate_key, "string");
  assert.ok(args.p_duplicate_key.length > 0, "scan must carry a Person key");
  assert.equal(args.p_date_of_birth, "1976-05-15");
  // Patients hold no Auth identity and no staff created this row.
  assert.equal(args.p_user_id, null);
  assert.equal(args.p_created_by, null);
  // The eKYC columns are retired; a scan must never claim OTP verification.
  assert.equal("p_aadhaar_hash" in args, false);
  assert.equal("p_aadhaar_verified_at" in args, false);
  assert.equal("p_aadhaar_kyc_ref" in args, false);
});

test("the same card twice derives the same Person key", async () => {
  const first = fakeSupabase(okRpc);
  __setServiceRoleClient(first.client);
  await post({ campId: CAMP_ID, campDayId: DAY_ID, phone: "9876543210", card: VALID_CARD });

  const second = fakeSupabase(okRpc);
  __setServiceRoleClient(second.client);
  await post({ campId: CAMP_ID, campDayId: DAY_ID, phone: "9000000000", card: VALID_CARD });

  assert.equal(
    first.calls.find((call) => call.fn === "register_patient_idempotent").args
      .p_duplicate_key,
    second.calls.find((call) => call.fn === "register_patient_idempotent").args
      .p_duplicate_key,
    "a different typed phone must not change the card's identity",
  );
});

test("a missing or short phone is refused before any write", async () => {
  const fake = fakeSupabase(okRpc);
  __setServiceRoleClient(fake.client);

  const response = await post({
    campId: CAMP_ID,
    campDayId: DAY_ID,
    phone: "98765",
    card: VALID_CARD,
  });

  assert.equal(response.status, 400);
  assert.equal(fake.calls.length, 0, "no RPC may run for an invalid phone");
});

test("a missing or invalid requestId is refused before any RPC", async () => {
  const fake = fakeSupabase(okRpc);
  __setServiceRoleClient(fake.client);

  const response = await post({
    requestId: "not-a-uuid",
    campId: CAMP_ID,
    campDayId: DAY_ID,
    phone: "9876543210",
    card: VALID_CARD,
  });

  assert.equal(response.status, 400);
  assert.equal(fake.calls.length, 0);
});

test("dummy repeated-digit phone is refused", async () => {
  const fake = fakeSupabase(okRpc);
  __setServiceRoleClient(fake.client);
  const response = await post({
    campId: CAMP_ID,
    campDayId: DAY_ID,
    phone: "0000000000",
    card: VALID_CARD,
  });
  assert.equal(response.status, 400);
  assert.equal(fake.calls.length, 0);
});

test("client-stable requestId is forwarded for idempotency", async () => {
  const fake = fakeSupabase(okRpc);
  __setServiceRoleClient(fake.client);
  const requestId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  await post({
    requestId,
    campId: CAMP_ID,
    campDayId: DAY_ID,
    phone: "9876543210",
    card: VALID_CARD,
  });
  const { args } = fake.calls.find(
    (call) => call.fn === "register_patient_idempotent",
  );
  assert.equal(args.p_request_id, requestId);
});

test("same-card re-scan returns existing reg and same-origin status link", async () => {
  const dupRpc = {
    data: null,
    error: { message: "AADHAAR_DUPLICATE:reg=99" },
  };
  const fake = fakeSupabase(dupRpc, { allowed: true, retry_after_seconds: 30 }, {
    existingByReg: {
      "99": {
        id: PATIENT_ID,
        reg_no: 99,
        status_token: "existing_tok",
        camp_day_id: DAY_ID,
        queue_status: "registered",
      },
    },
  });
  __setServiceRoleClient(fake.client);
  const response = await post({
    campId: CAMP_ID,
    campDayId: DAY_ID,
    phone: "9876543210",
    card: VALID_CARD,
  });
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.existing, true);
  assert.equal(body.registrationNumber, 99);
  assert.equal(body.statusUrl, undefined);
  // The token lookup must stay inside the camp being registered into —
  // reg_no alone is only unique per camp (UNIQUE(camp_id, reg_no)).
  const lookup = fake.calls.find((call) => call.fn === "select:patients");
  assert.deepEqual(lookup.filters, [
    ["camp_id", CAMP_ID],
    ["reg_no", 99],
  ]);
});

test("soft likely-duplicate never returns a status link", async () => {
  const softRpc = {
    data: null,
    error: { message: "LIKELY_DUPLICATE:reg=77" },
  };
  const fake = fakeSupabase(softRpc, { allowed: true, retry_after_seconds: 30 }, {
    existingByReg: {
      "77": {
        id: PATIENT_ID,
        reg_no: 77,
        status_token: "must_not_leak",
        camp_day_id: DAY_ID,
        queue_status: "registered",
      },
    },
  });
  __setServiceRoleClient(fake.client);
  const response = await post({
    campId: CAMP_ID,
    campDayId: DAY_ID,
    phone: "9876543210",
    card: VALID_CARD,
  });
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.deskReferral, true);
  assert.equal(body.registrationNumber, 77);
  assert.equal(body.statusUrl, undefined);
});

test("a half-read card is refused rather than registered with gaps", async () => {
  const fake = fakeSupabase(okRpc);
  __setServiceRoleClient(fake.client);

  const response = await post({
    campId: CAMP_ID,
    campDayId: DAY_ID,
    phone: "9876543210",
    card: { ...VALID_CARD, dateOfBirth: "", aadhaarLast4: "" },
  });

  assert.equal(response.status, 400);
  assert.equal(fake.calls.length, 0);
});

test("a non-Latin card name is blocked until a Latin spelling is supplied", async () => {
  const devanagari = { ...VALID_CARD, fullName: "रमेश कुमार" };

  const blocked = fakeSupabase(okRpc);
  __setServiceRoleClient(blocked.client);
  const refusal = await post({
    campId: CAMP_ID,
    campDayId: DAY_ID,
    phone: "9876543210",
    card: devanagari,
  });
  assert.equal(refusal.status, 400);
  assert.equal(blocked.calls.length, 0);

  const allowed = fakeSupabase(okRpc);
  __setServiceRoleClient(allowed.client);
  const accepted = await post({
    campId: CAMP_ID,
    campDayId: DAY_ID,
    phone: "9876543210",
    card: { ...devanagari, displayName: "Ramesh Kumar" },
  });
  assert.equal((await accepted.json()).ok, true);
  // The key must come from the verbatim card name, never the transliteration,
  // so two different spellings cannot mint two Persons.
  const registration = allowed.calls.find(
    (call) => call.fn === "register_patient_idempotent",
  );
  assert.equal(registration.args.p_full_name, "रमेश कुमार");
  assert.equal(registration.args.p_display_name, "Ramesh Kumar");
});

test("an existing registration sends the patient to the desk with their number", async () => {
  const fake = fakeSupabase({
    data: null,
    error: { message: "AADHAAR_DUPLICATE:reg=10042" },
  });
  __setServiceRoleClient(fake.client);

  const body = await (
    await post({ campId: CAMP_ID, campDayId: DAY_ID, phone: "9876543210", card: VALID_CARD })
  ).json();

  assert.equal(body.ok, false);
  assert.equal(body.deskReferral, true);
  assert.equal(body.registrationNumber, 10042);
});

test("a full camp day is refused with a message that names the cause", async () => {
  const fake = fakeSupabase({
    data: null,
    error: { message: "Camp day is full" },
  });
  __setServiceRoleClient(fake.client);

  const response = await post({
    campId: CAMP_ID,
    campDayId: DAY_ID,
    phone: "9876543210",
    card: VALID_CARD,
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /full/i);
});

test("an unconfigured service role degrades instead of throwing", async () => {
  __setServiceRoleClient(null);

  const response = await post({
    campId: CAMP_ID,
    campDayId: DAY_ID,
    phone: "9876543210",
    card: VALID_CARD,
  });

  assert.equal(response.status, 503);
  assert.equal((await response.json()).ok, false);
});

test("a durable rate-limit denial prevents the registration RPC", async () => {
  const fake = fakeSupabase(okRpc, {
    allowed: false,
    retry_after_seconds: 45,
  });
  __setServiceRoleClient(fake.client);

  const response = await post({
    campId: CAMP_ID,
    campDayId: DAY_ID,
    phone: "9876543210",
    card: VALID_CARD,
  });

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "45");
  assert.deepEqual(
    fake.calls.map((call) => call.fn),
    ["consume_public_rate_limit"],
  );
});

test("an oversized public JSON body is rejected before any RPC", async () => {
  const fake = fakeSupabase(okRpc);
  __setServiceRoleClient(fake.client);

  const response = await post({
    campId: CAMP_ID,
    campDayId: DAY_ID,
    phone: "9876543210",
    card: VALID_CARD,
    padding: "x".repeat(20_000),
  });

  assert.equal(response.status, 400);
  assert.equal(fake.calls.length, 0);
});
