/**
 * Desk register → print → reset flow and retry semantics (#47, #60).
 * Only explicit transient classifications are auto-retried.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  isRetryableRegistrationError,
  runDeskRegisterAndPrint,
  withRegistrationRetries,
} from "../src/lib/desk-register-flow.ts";
import { createRegistrationAttempt } from "../src/lib/registration-request.ts";

const staffFields = {
  campId: "11111111-1111-4111-8111-111111111111",
  fullName: "Test Patient",
  gender: null,
  age: 30,
  address: null,
  phone: null,
  email: null,
  aadhaarLast4: null,
  createdBy: "44444444-4444-4444-8444-444444444444",
  campDayId: "22222222-2222-4222-8222-222222222222",
};

test("aadhaar/likely duplicates and terminal errors are not retryable; transport is", () => {
  assert.equal(
    isRetryableRegistrationError({
      data: null,
      error: "AADHAAR_DUPLICATE:reg=9",
      aadhaarDuplicateRegNo: 9,
      retryable: false,
    }),
    false,
  );
  assert.equal(
    isRetryableRegistrationError({
      data: null,
      error: "LIKELY_DUPLICATE:reg=12",
      likelyDuplicateRegNo: 12,
      retryable: false,
    }),
    false,
  );
  assert.equal(
    isRetryableRegistrationError({
      data: null,
      error: "That camp day is full. Choose another day.",
      retryable: false,
      publicCategory: "capacity",
    }),
    false,
  );
  assert.equal(
    isRetryableRegistrationError({
      data: null,
      error: "Registration service is unavailable. Check your connection and try again.",
      retryable: true,
      publicCategory: "transient",
    }),
    true,
  );
  // Legacy string-only results without retryable flag must NOT retry (#60 allow-list).
  assert.equal(
    isRetryableRegistrationError({
      data: null,
      error: "network blip",
    }),
    false,
  );
  assert.equal(
    isRetryableRegistrationError({ data: {}, error: null }),
    false,
  );
});

test("retries twice on retryable=true then surfaces the plain failure sentence", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await withRegistrationRetries(
    async () => {
      calls += 1;
      return {
        data: null,
        error: "temp",
        retryable: true,
        publicCategory: "transient",
      };
    },
    {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  );
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [250, 750]);
  assert.equal(
    result.error,
    "Could not save. Check the internet and press Try Again.",
  );
});

test("success on second attempt stops retries", async () => {
  let calls = 0;
  const result = await withRegistrationRetries(
    async () => {
      calls += 1;
      if (calls === 1) {
        return {
          data: null,
          error: "blip",
          retryable: true,
        };
      }
      return { data: [{ id: "p1" }], error: null, retryable: false };
    },
    { sleep: async () => {} },
  );
  assert.equal(calls, 2);
  assert.equal(result.error, null);
});

test("aadhaar conflict is not retried", async () => {
  let calls = 0;
  const result = await withRegistrationRetries(
    async () => {
      calls += 1;
      return {
        data: null,
        error: "AADHAAR_DUPLICATE:reg=12",
        aadhaarDuplicateRegNo: 12,
        retryable: false,
      };
    },
    { sleep: async () => {} },
  );
  assert.equal(calls, 1);
  assert.equal(result.aadhaarDuplicateRegNo, 12);
});

test("likely-duplicate warning is not retried", async () => {
  let calls = 0;
  const result = await withRegistrationRetries(
    async () => {
      calls += 1;
      return {
        data: null,
        error: "LIKELY_DUPLICATE:reg=214",
        likelyDuplicateRegNo: 214,
        retryable: false,
      };
    },
    { sleep: async () => {} },
  );
  assert.equal(calls, 1);
  assert.equal(result.likelyDuplicateRegNo, 214);
});

test("day-full structured error is not retried and keeps capacity copy", async () => {
  let calls = 0;
  const attempt = createRegistrationAttempt(
    () => "dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  );
  const outcome = await runDeskRegisterAndPrint({
    attempt,
    staffFields,
    rpc: async () => {
      calls += 1;
      return {
        data: null,
        error: {
          code: "P0001",
          message: "This day is full (40 seats). Choose another day.",
        },
      };
    },
    openPrint: () => {},
    resetForm: () => {},
    rotateAttempt: () => {},
    sleep: async () => {},
  });
  assert.equal(calls, 1);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.error, /full|another day/i);
  assert.doesNotMatch(outcome.error, /internet|Could not save/i);
});

test("permission denial is not retried", async () => {
  let calls = 0;
  const attempt = createRegistrationAttempt(
    () => "eeeeeeee-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  );
  const outcome = await runDeskRegisterAndPrint({
    attempt,
    staffFields,
    rpc: async () => {
      calls += 1;
      return {
        data: null,
        error: {
          code: "42501",
          message: "permission denied for function register_patient_idempotent",
        },
      };
    },
    openPrint: () => {},
    resetForm: () => {},
    rotateAttempt: () => {},
    sleep: async () => {},
  });
  assert.equal(calls, 1);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.error, /permission/i);
});

test("connection-class error is retried then exhausted", async () => {
  let calls = 0;
  const attempt = createRegistrationAttempt(
    () => "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  );
  const outcome = await runDeskRegisterAndPrint({
    attempt,
    staffFields,
    rpc: async () => {
      calls += 1;
      return {
        data: null,
        error: { code: "08006", message: "connection_failure" },
      };
    },
    openPrint: () => {},
    resetForm: () => {},
    rotateAttempt: () => {},
    sleep: async () => {},
  });
  assert.equal(calls, 3);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(
    outcome.error,
    "Could not save. Check the internet and press Try Again.",
  );
});

test("runDeskRegisterAndPrint surfaces likelyDuplicateRegNo", async () => {
  const attempt = createRegistrationAttempt(() => "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  const outcome = await runDeskRegisterAndPrint({
    attempt,
    staffFields,
    rpc: async () => ({
      data: null,
      error: { message: "LIKELY_DUPLICATE:reg=88" },
    }),
    openPrint: () => {},
    resetForm: () => {},
    rotateAttempt: () => {},
    sleep: async () => {},
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.likelyDuplicateRegNo, 88);
});

test("register-then-print: same request id on retries; print then reset order", async () => {
  const attempt = createRegistrationAttempt(() => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  const requestIds = [];
  /** @type {string[]} */
  const events = [];
  let rpcCalls = 0;

  const outcome = await runDeskRegisterAndPrint({
    attempt,
    staffFields,
    rpc: async (_fn, args) => {
      rpcCalls += 1;
      requestIds.push(args.p_request_id);
      if (rpcCalls < 2) {
        return {
          data: null,
          error: { code: "08006", message: "connection_failure" },
        };
      }
      return {
        data: [
          {
            id: "patient-1",
            reg_no: 7,
            full_name: "Test Patient",
            queue_status: "waiting",
          },
        ],
        error: null,
      };
    },
    openPrint: (id) => {
      events.push(`print:${id}`);
    },
    resetForm: () => {
      events.push("reset");
    },
    rotateAttempt: () => {
      events.push("rotate");
      attempt.rotate();
    },
    sleep: async () => {},
  });

  assert.equal(outcome.ok, true);
  assert.equal(rpcCalls, 2);
  assert.deepEqual(requestIds, [
    "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  ]);
  // Queue already done by RPC; print opens before reset.
  assert.deepEqual(events, ["print:patient-1", "rotate", "reset"]);
});

test("failed register never opens print or resets", async () => {
  const attempt = createRegistrationAttempt(() => "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  /** @type {string[]} */
  const events = [];

  const outcome = await runDeskRegisterAndPrint({
    attempt,
    staffFields,
    rpc: async () => ({
      data: null,
      error: { code: "08006", message: "connection_failure" },
    }),
    openPrint: () => events.push("print"),
    resetForm: () => events.push("reset"),
    rotateAttempt: () => events.push("rotate"),
    sleep: async () => {},
  });

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(
    outcome.error,
    "Could not save. Check the internet and press Try Again.",
  );
  assert.deepEqual(events, []);
});
