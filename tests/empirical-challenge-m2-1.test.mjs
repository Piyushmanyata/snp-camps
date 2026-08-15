/**
 * Empirical Stress Test Harness for #60 (Desk Failure Retries) and
 * #62 (Register & Print Popup Blocker Survival).
 *
 * The #61 database-integration tests live in
 * empirical-challenge-m2-1.db.test.mjs — they need Postgres, and this suite
 * must stay DB-free so a green run means green.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

import {
  classifyOperationError,
} from "../src/lib/public-error.ts";

import {
  lookupPatientScanWithRetries,
  changeCampDayWithRetries,
} from "../src/lib/desk-ops.ts";

import {
  acquireDeskPrintTarget,
  runDeskRegisterAndPrint,
} from "../src/lib/desk-register-flow.ts";

import { RETRY_EXHAUSTED_COPY } from "../src/lib/with-retries.ts";

// --------------------------------------------------------------------------
// SECTION 1: FAILURE RETRIES & ERROR CLASSIFICATION (#60)
// --------------------------------------------------------------------------

test("STRESS #60: DB Connection drops, timeouts, and transport errors are retryable allow-list", () => {
  const retryableCodes = ["08000", "08001", "08006", "08007", "08P01", "40001", "40P01", "57014", "57P03", "53300"];
  for (const code of retryableCodes) {
    const res = classifyOperationError({ code, message: `Error ${code}` }, { log: false });
    assert.equal(res.retryable, true, `Expected code ${code} to be retryable`);
    assert.ok(
      res.publicCategory === "transient" || res.publicCategory === "timeout",
      `Expected category transient/timeout for code ${code}, got ${res.publicCategory}`
    );
  }

  // Class 08 prefix wildcard check
  const customClass08 = classifyOperationError({ code: "08999", message: "Connection lost" }, { log: false });
  assert.equal(customClass08.retryable, true);

  // Transport failure flag
  const transportFlag = classifyOperationError("Custom network error", { transportFailure: true, log: false });
  assert.equal(transportFlag.retryable, true);
  assert.equal(transportFlag.publicCategory, "transient");

  // HTTP 5xx
  const http503 = classifyOperationError({ status: 503, message: "Service Unavailable" }, { log: false });
  assert.equal(http503.retryable, true);

  // Browser fetch errors
  const fetchError = classifyOperationError({ message: "TypeError: Failed to fetch" }, { log: false });
  assert.equal(fetchError.retryable, true);
});

test("STRESS #60: Terminal business, validation, permission, and unknown errors are NEVER retryable", () => {
  const terminalCases = [
    { err: { code: "P0001", message: "That day is full (40 seats taken)" }, category: "capacity" },
    { err: { code: "42501", message: "permission denied for function register_patient_idempotent" }, category: "permission" },
    { err: { code: "23505", message: "duplicate key value violates unique constraint" }, category: "conflict" },
    { err: { code: "P0001", message: "AADHAAR_DUPLICATE:reg=10042" }, category: "duplicate" },
    { err: { code: "P0001", message: "LIKELY_DUPLICATE:reg=10050" }, category: "duplicate" },
    { err: { code: "22P02", message: "invalid input syntax for type integer: abc" }, category: "validation" },
    { err: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" }, category: "not_found" },
    { err: { code: "PGRST202", message: "Could not find function in schema cache" }, category: "unknown" },
    { err: { code: "XX000", message: "Internal server error" }, category: "unknown" },
  ];

  for (const { err, category } of terminalCases) {
    const res = classifyOperationError(err, { log: false });
    assert.equal(res.retryable, false, `Expected error ${err.code || err.message} to NOT be retryable`);
    assert.equal(res.publicCategory, category, `Expected category ${category} for ${err.code || err.message}`);
  }
});

test("STRESS #60: Log masking — sensitive internal DB detail is never leaked to public message", () => {
  const secretErr = {
    code: "42501",
    message: "permission denied for table secret_patients_internal_table",
    details: "Key (id)=(123) violates internal security policy secret_auth_schema",
    hint: "Contact database administrator superuser@prod-db.internal",
  };

  const classified = classifyOperationError(secretErr, { log: false });
  assert.equal(classified.publicCategory, "permission");
  assert.equal(classified.publicMessage, "You do not have permission for this action.");
  assert.ok(!classified.publicMessage.includes("secret_patients_internal_table"));
  assert.ok(!classified.publicMessage.includes("secret_auth_schema"));
  assert.ok(!classified.publicMessage.includes("superuser@prod-db.internal"));
});

test("STRESS #60: Retry loop stops immediately on non-retryable error (0 extra attempts)", async () => {
  let callCount = 0;
  const mockRpc = async () => {
    callCount++;
    return {
      data: null,
      error: { code: "P0001", message: "That day is full (40 seats taken)" },
    };
  };

  const res = await changeCampDayWithRetries({
    patientId: randomUUID(),
    newDayId: randomUUID(),
    rpc: mockRpc,
  });

  assert.equal(callCount, 1, "Should stop after 1 attempt on non-retryable error");
  assert.equal(res.ok, false);
  assert.equal(res.error, "That camp day is full. Choose another day.");
});

test("STRESS #60: Transient failure retries up to max 3 attempts then returns exhausted copy", async () => {
  let callCount = 0;
  const mockRpc = async () => {
    callCount++;
    return {
      data: null,
      error: { code: "08006", message: "connection_failure" },
    };
  };

  const res = await lookupPatientScanWithRetries({
    patientId: randomUUID(),
    rpc: mockRpc,
    sleep: async () => {},
  });

  assert.equal(callCount, 3, "Expected 3 attempts (1 initial + 2 retries)");
  assert.equal(res.ok, false);
  assert.equal(res.error, RETRY_EXHAUSTED_COPY.lookup);
});

// --------------------------------------------------------------------------
// SECTION 2: POPUP BLOCKER SURVIVAL & REGISTER-AND-PRINT FLOW (#62)
// --------------------------------------------------------------------------

test("STRESS #62: acquireDeskPrintTarget never uses 'noopener' feature string", () => {
  let passedFeatures = null;
  const mockOpenWindow = (url, target, features) => {
    passedFeatures = features;
    return { closed: false, opener: {}, location: { href: "" }, close() {} };
  };

  acquireDeskPrintTarget(mockOpenWindow);
  assert.equal(passedFeatures, undefined, "Features should be undefined, never containing noopener");
});

test("STRESS #62: Blocked popup window (window.open -> null) completes registration with recovery state", async () => {
  const mockOpenWindow = () => null; // Popup blocked
  const printTarget = acquireDeskPrintTarget(mockOpenWindow);
  assert.equal(printTarget.acquired, false);

  const patientId = randomUUID();
  let onSuccessCalled = false;
  let onSuccessInfo = null;
  let formReset = false;
  let attemptRotated = false;

  const mockRpc = async () => {
    return {
      data: [{ id: patientId, reg_no: 1001, full_name: "Test Patient" }],
      error: null,
    };
  };

  const res = await runDeskRegisterAndPrint({
    attempt: { id: randomUUID() },
    staffFields: { campDayId: randomUUID(), fullName: "Test Patient", gender: "M", age: 30 },
    rpc: mockRpc,
    printTarget,
    resetForm: () => { formReset = true; },
    rotateAttempt: () => { attemptRotated = true; },
    onSuccess: (info) => {
      onSuccessCalled = true;
      onSuccessInfo = info;
    },
  });

  assert.equal(res.ok, true);
  assert.equal(res.print, "recovery");
  assert.equal(onSuccessCalled, true);
  assert.equal(onSuccessInfo?.row.id, patientId);
  assert.equal(onSuccessInfo?.print, "recovery");
  assert.equal(formReset, true);
  assert.equal(attemptRotated, true);
});

test("STRESS #62: Closed target handle returns print='recovery' without crashing or double registration", async () => {
  let rpcExecutions = 0;
  const patientId = randomUUID();
  const mockHandle = {
    closed: true, // User/popup-blocker closed the tab mid-request
    opener: {},
    location: { href: "" },
    close() {},
  };

  const mockOpenWindow = () => mockHandle;
  const printTarget = acquireDeskPrintTarget(mockOpenWindow);
  assert.equal(printTarget.acquired, true);

  const mockRpc = async () => {
    rpcExecutions++;
    return {
      data: [{ id: patientId, reg_no: 1002, full_name: "Closed Window Patient" }],
      error: null,
    };
  };

  let onSuccessInfo = null;

  const res = await runDeskRegisterAndPrint({
    attempt: { id: randomUUID() },
    staffFields: { campDayId: randomUUID(), fullName: "Closed Window Patient", gender: "F", age: 25 },
    rpc: mockRpc,
    printTarget,
    resetForm: () => {},
    rotateAttempt: () => {},
    onSuccess: (info) => { onSuccessInfo = info; },
  });

  assert.equal(rpcExecutions, 1);
  assert.equal(res.ok, true);
  assert.equal(res.print, "recovery");
  assert.equal(onSuccessInfo?.print, "recovery");
});

test("STRESS #62: Registration failure abandons print target tab without form reset or onSuccess callback", async () => {
  let abandoned = false;
  const mockHandle = {
    closed: false,
    opener: {},
    location: { href: "" },
    close() { abandoned = true; },
  };

  const printTarget = acquireDeskPrintTarget(() => mockHandle);
  let formReset = false;
  let onSuccessCalled = false;

  const mockRpc = async () => {
    return {
      data: null,
      error: { code: "P0001", message: "That day is full (40 seats taken)" },
    };
  };

  const res = await runDeskRegisterAndPrint({
    attempt: { id: randomUUID() },
    staffFields: { campDayId: randomUUID(), fullName: "Failed Patient", gender: "M", age: 40 },
    rpc: mockRpc,
    printTarget,
    resetForm: () => { formReset = true; },
    rotateAttempt: () => {},
    onSuccess: () => { onSuccessCalled = true; },
  });

  assert.equal(res.ok, false);
  assert.equal(abandoned, true, "Blank tab should be abandoned/closed on error");
  assert.equal(formReset, false, "Form should NOT be reset on failure");
  assert.equal(onSuccessCalled, false, "onSuccess should NOT be called on failure");
});
