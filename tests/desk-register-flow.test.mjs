/**
 * Desk register → print → reset flow, popup recovery, and retry semantics (#47, #60, #62).
 * Only explicit transient classifications are auto-retried.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  acquireDeskPrintTarget,
  isRetryableRegistrationError,
  patientPrintPath,
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

/** @returns {import("../src/lib/desk-register-flow.ts").DeskPrintTarget} */
function mockPrintTarget(overrides = {}) {
  return {
    acquired: true,
    navigate: () => true,
    abandon: () => {},
    ...overrides,
  };
}

test("patientPrintPath points at auto-print slip route", () => {
  assert.equal(
    patientPrintPath("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
    "/print/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee?auto=1",
  );
});

test("acquireDeskPrintTarget: blocked null is distinct from valid handle", () => {
  const blocked = acquireDeskPrintTarget(() => null);
  assert.equal(blocked.acquired, false);
  assert.equal(blocked.navigate("p1"), false);
  blocked.abandon(); // no-op

  /** @type {{ closed: boolean, opener: unknown, location: { href: string }, close: () => void, features?: string }} */
  let lastHandle;
  let openFeatures;
  const acquired = acquireDeskPrintTarget((_url, _target, features) => {
    openFeatures = features;
    lastHandle = {
      closed: false,
      opener: { parent: true },
      location: { href: "about:blank" },
      close() {
        this.closed = true;
      },
    };
    return lastHandle;
  });

  // Must not pass noopener — browsers null the return value for noopener opens.
  assert.equal(openFeatures, undefined);
  assert.equal(acquired.acquired, true);
  assert.equal(lastHandle.opener, null);

  assert.equal(acquired.navigate("patient-99"), true);
  assert.equal(
    lastHandle.location.href,
    "/print/patient-99?auto=1",
  );
});

test("acquireDeskPrintTarget: opener severed before any caller await can run", () => {
  const events = [];
  const target = acquireDeskPrintTarget(() => {
    events.push("open");
    return {
      closed: false,
      get opener() {
        return this._opener;
      },
      set opener(v) {
        events.push("opener-null");
        this._opener = v;
      },
      _opener: {},
      location: { href: "about:blank" },
      close() {},
    };
  });
  assert.deepEqual(events, ["open", "opener-null"]);
  assert.equal(target.acquired, true);
});

test("acquireDeskPrintTarget: closed handle returns false and abandon closes blank tab", () => {
  let closed = false;
  const handle = {
    get closed() {
      return closed;
    },
    opener: {},
    location: { href: "about:blank" },
    close() {
      closed = true;
    },
  };
  const target = acquireDeskPrintTarget(() => handle);
  closed = true;
  assert.equal(target.navigate("p1"), false);

  closed = false;
  target.abandon();
  assert.equal(closed, true);
  assert.equal(target.navigate("p1"), false); // abandoned
});

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
  let abandoned = false;
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
    printTarget: mockPrintTarget({
      abandon: () => {
        abandoned = true;
      },
    }),
    resetForm: () => {},
    rotateAttempt: () => {},
    sleep: async () => {},
  });
  assert.equal(calls, 1);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.error, /full|another day/i);
  assert.doesNotMatch(outcome.error, /internet|Could not save/i);
  assert.equal(outcome.showTryAgain, false);
  assert.equal(abandoned, true);
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
    printTarget: mockPrintTarget(),
    resetForm: () => {},
    rotateAttempt: () => {},
    sleep: async () => {},
  });
  assert.equal(calls, 1);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.error, /permission/i);
  assert.equal(outcome.showTryAgain, false);
});

test("connection-class error is retried then exhausted with showTryAgain", async () => {
  let calls = 0;
  let abandoned = false;
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
    printTarget: mockPrintTarget({
      abandon: () => {
        abandoned = true;
      },
    }),
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
  assert.equal(outcome.showTryAgain, true);
  assert.equal(abandoned, true);
});

test("runDeskRegisterAndPrint surfaces likelyDuplicateRegNo and abandons target", async () => {
  let abandoned = false;
  const attempt = createRegistrationAttempt(() => "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  const outcome = await runDeskRegisterAndPrint({
    attempt,
    staffFields,
    rpc: async () => ({
      data: null,
      error: { message: "LIKELY_DUPLICATE:reg=88" },
    }),
    printTarget: mockPrintTarget({
      abandon: () => {
        abandoned = true;
      },
    }),
    resetForm: () => {},
    rotateAttempt: () => {},
    sleep: async () => {},
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.likelyDuplicateRegNo, 88);
  assert.equal(outcome.showTryAgain, false);
  assert.equal(abandoned, true);
});

test("register-then-print: same request id on retries; navigate then onSuccess then rotate/reset", async () => {
  const attempt = createRegistrationAttempt(() => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  const requestIds = [];
  /** @type {string[]} */
  const events = [];
  let rpcCalls = 0;
  /** @type {string | null} */
  let navigatedTo = null;

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
    printTarget: {
      acquired: true,
      navigate(id) {
        navigatedTo = id;
        events.push(`navigate:${id}`);
        return true;
      },
      abandon: () => events.push("abandon"),
    },
    onSuccess: ({ row, print }) => {
      events.push(`onSuccess:${row.id}:${print}`);
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
  if (!outcome.ok) return;
  assert.equal(outcome.print, "navigated");
  assert.equal(rpcCalls, 2);
  assert.equal(navigatedTo, "patient-1");
  assert.deepEqual(requestIds, [
    "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  ]);
  // onSuccess before rotate/reset so recovery is retained first.
  assert.deepEqual(events, [
    "navigate:patient-1",
    "onSuccess:patient-1:navigated",
    "rotate",
    "reset",
  ]);
});

test("register-only: no print target → print=skipped and no window", async () => {
  const attempt = createRegistrationAttempt(() => "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  /** @type {string[]} */
  const events = [];
  let rpcCalls = 0;

  const outcome = await runDeskRegisterAndPrint({
    attempt,
    staffFields,
    rpc: async () => {
      rpcCalls += 1;
      return {
        data: [
          {
            id: "patient-no-print",
            reg_no: 11,
            full_name: "Register Only",
            queue_status: "registered",
          },
        ],
        error: null,
      };
    },
    printTarget: null,
    onSuccess: ({ row, print }) => {
      events.push(`onSuccess:${row.id}:${print}`);
    },
    resetForm: () => {
      events.push("reset");
    },
    rotateAttempt: () => {
      events.push("rotate");
    },
    sleep: async () => {},
  });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.print, "skipped");
  assert.equal(rpcCalls, 1);
  assert.deepEqual(events, [
    "onSuccess:patient-no-print:skipped",
    "rotate",
    "reset",
  ]);
});

test("blocked popup: registration succeeds once, print=recovery, no false navigate", async () => {
  const attempt = createRegistrationAttempt(() => "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  /** @type {string[]} */
  const events = [];
  let rpcCalls = 0;

  const outcome = await runDeskRegisterAndPrint({
    attempt,
    staffFields,
    rpc: async () => {
      rpcCalls += 1;
      return {
        data: [
          {
            id: "patient-blocked",
            reg_no: 3,
            full_name: "Blocked Print",
            queue_status: "waiting",
          },
        ],
        error: null,
      };
    },
    printTarget: {
      acquired: false,
      navigate: () => {
        events.push("navigate");
        return false;
      },
      abandon: () => events.push("abandon"),
    },
    onSuccess: ({ print }) => events.push(`onSuccess:${print}`),
    resetForm: () => events.push("reset"),
    rotateAttempt: () => events.push("rotate"),
    sleep: async () => {},
  });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.print, "recovery");
  assert.equal(rpcCalls, 1);
  assert.deepEqual(events, [
    "navigate",
    "abandon",
    "onSuccess:recovery",
    "rotate",
    "reset",
  ]);
});

test("closed target after delay: recovery path, patient still registered", async () => {
  const attempt = createRegistrationAttempt(() => "abababab-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  const outcome = await runDeskRegisterAndPrint({
    attempt,
    staffFields,
    rpc: async () => ({
      data: [
        {
          id: "patient-closed",
          reg_no: 11,
          full_name: "Closed Tab",
          queue_status: "registered",
        },
      ],
      error: null,
    }),
    printTarget: {
      acquired: true,
      navigate: () => false, // closed before navigate
      abandon: () => {},
    },
    resetForm: () => {},
    rotateAttempt: () => {},
    sleep: async () => {},
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.print, "recovery");
  assert.equal(outcome.row.id, "patient-closed");
});

test("failed register never navigates print or resets", async () => {
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
    printTarget: {
      acquired: true,
      navigate: () => {
        events.push("navigate");
        return true;
      },
      abandon: () => events.push("abandon"),
    },
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
  assert.equal(outcome.showTryAgain, true);
  assert.deepEqual(events, ["abandon"]);
});

test("noop openWindow features string never includes noopener in helper contract", () => {
  // Guard: if a future caller passes features into open, the helper itself
  // must still call open with only url+target (no third arg).
  const calls = [];
  acquireDeskPrintTarget((url, target, features) => {
    calls.push({ url: String(url), target, features });
    return null;
  });
  assert.deepEqual(calls, [
    { url: "about:blank", target: "_blank", features: undefined },
  ]);
});
