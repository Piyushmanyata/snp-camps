/**
 * Behavioural coverage for registration idempotency / requestId outbound paths.
 * Exercises the same module PatientForm uses to call the staff RPC.
 * Deliberately does not grep component source for the string "requestId".
 * Public self-registration uses its dedicated `/self-register` API boundary.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createRegistrationAttempt,
  parseAadhaarDuplicateError,
  parseLikelyDuplicateError,
  staffRegistrationRpcArgs,
  submitRegistrationOutbound,
} from "../src/lib/registration-request.ts";
import { createRequestId } from "../src/lib/request-id.ts";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function newAttempt() {
  return createRegistrationAttempt(createRequestId);
}

const staffFields = {
  campId: "11111111-1111-4111-8111-111111111111",
  fullName: "Test Patient",
  gender: "F",
  age: 30,
  address: "1 Test St",
  phone: "9876543210",
  email: null,
  aadhaarLast4: "1234",
  createdBy: "44444444-4444-4444-8444-444444444444",
  campDayId: "22222222-2222-4222-8222-222222222222",
};

test("non-staff registration is rejected (desk only)", async () => {
  const attempt = newAttempt();
  const result = await submitRegistrationOutbound({
    isStaff: false,
    attempt,
  });
  assert.equal(result.data, null);
  assert.match(String(result.error), /desk only/i);
});

test("staff registration submit sends a non-empty UUID p_request_id to the RPC", async () => {
  const attempt = newAttempt();
  /** @type {unknown} */
  let capturedArgs = null;

  const result = await submitRegistrationOutbound({
    isStaff: true,
    attempt,
    staffFields,
    rpc: async (fn, args) => {
      assert.equal(fn, "register_patient_idempotent");
      capturedArgs = args;
      return {
        data: [{ id: "p2", reg_no: 2, full_name: staffFields.fullName }],
        error: null,
      };
    },
  });

  assert.equal(result.error, null);
  assert.ok(capturedArgs && typeof capturedArgs === "object");
  const args = /** @type {{ p_request_id?: string }} */ (capturedArgs);
  assert.equal(typeof args.p_request_id, "string");
  assert.ok(args.p_request_id.length > 0, "p_request_id must be non-empty");
  assert.match(args.p_request_id, UUID_V4);
  assert.equal(args.p_request_id, attempt.id);
  assert.equal(
    /** @type {{ p_user_id?: unknown }} */ (args).p_user_id,
    null,
    "patient ownership p_user_id retired (#59)",
  );
});

test("requestId is stable across retries of the same submission", async () => {
  const attempt = newAttempt();
  const ids = [];

  for (let i = 0; i < 3; i += 1) {
    await submitRegistrationOutbound({
      isStaff: true,
      attempt,
      staffFields,
      rpc: async (_fn, args) => {
        ids.push(args.p_request_id);
        return { data: null, error: { message: "temporary" } };
      },
    });
  }

  assert.equal(ids.length, 3);
  assert.equal(ids[0], ids[1]);
  assert.equal(ids[1], ids[2]);
  assert.equal(ids[0], attempt.id);
});

test("requestId rotates after success (next walk-in) and after resetForm", async () => {
  const attempt = newAttempt();
  const first = attempt.id;

  await submitRegistrationOutbound({
    isStaff: true,
    attempt,
    staffFields,
    rpc: async () => ({
      data: [{ id: "p1", reg_no: 1, full_name: "X" }],
      error: null,
    }),
  });

  // PatientForm rotates only after a successful row is returned.
  attempt.rotate();
  const afterSuccess = attempt.id;
  assert.notEqual(afterSuccess, first);
  assert.match(afterSuccess, UUID_V4);

  // resetForm also rotates so a new attempt starts clean.
  attempt.rotate();
  const afterReset = attempt.id;
  assert.notEqual(afterReset, afterSuccess);
  assert.match(afterReset, UUID_V4);
});

test("staff payload builder includes the attempt id (not optional)", () => {
  const attempt = createRegistrationAttempt(
    () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  );
  const staffArgs = staffRegistrationRpcArgs(attempt, staffFields);

  assert.equal(staffArgs.p_request_id, attempt.id);
  assert.equal(staffArgs.p_aadhaar_duplicate_override, false);
  assert.equal(staffArgs.p_likely_duplicate_override, false);
  assert.equal(
    Object.prototype.hasOwnProperty.call(staffArgs, "p_request_id"),
    true,
  );
});

test("parseAadhaarDuplicateError extracts reg no and ignores noise", () => {
  assert.deepEqual(parseAadhaarDuplicateError("AADHAAR_DUPLICATE:reg=1042"), {
    regNo: 1042,
  });
  assert.equal(parseAadhaarDuplicateError("duplicate key value"), null);
  assert.equal(parseAadhaarDuplicateError(null), null);
});

test("staff RPC passes one-shot aadhaar override flag", async () => {
  const attempt = newAttempt();
  /** @type {unknown} */
  let capturedArgs = null;

  await submitRegistrationOutbound({
    isStaff: true,
    attempt,
    staffFields: { ...staffFields, aadhaarDuplicateOverride: true },
    rpc: async (_fn, args) => {
      capturedArgs = args;
      return { data: null, error: { message: "AADHAAR_DUPLICATE:reg=99" } };
    },
  });

  const args = /** @type {{ p_aadhaar_duplicate_override?: boolean }} */ (
    capturedArgs
  );
  assert.equal(args.p_aadhaar_duplicate_override, true);
});

test("staff outbound surfaces aadhaarDuplicateRegNo from RPC error", async () => {
  const attempt = newAttempt();
  const result = await submitRegistrationOutbound({
    isStaff: true,
    attempt,
    staffFields,
    rpc: async () => ({
      data: null,
      error: { message: "AADHAAR_DUPLICATE:reg=2048" },
    }),
  });
  assert.equal(result.aadhaarDuplicateRegNo, 2048);
  assert.match(String(result.error), /AADHAAR_DUPLICATE:reg=2048/);
});

test("parseLikelyDuplicateError extracts reg no", () => {
  assert.deepEqual(parseLikelyDuplicateError("LIKELY_DUPLICATE:reg=214"), {
    regNo: 214,
  });
  assert.equal(parseLikelyDuplicateError("AADHAAR_DUPLICATE:reg=1"), null);
  assert.equal(parseLikelyDuplicateError(null), null);
});

test("staff RPC passes one-shot likely-duplicate override flag", async () => {
  const attempt = newAttempt();
  /** @type {unknown} */
  let capturedArgs = null;

  await submitRegistrationOutbound({
    isStaff: true,
    attempt,
    staffFields: { ...staffFields, likelyDuplicateOverride: true },
    rpc: async (_fn, args) => {
      capturedArgs = args;
      return { data: null, error: { message: "LIKELY_DUPLICATE:reg=7" } };
    },
  });

  const args = /** @type {{ p_likely_duplicate_override?: boolean }} */ (
    capturedArgs
  );
  assert.equal(args.p_likely_duplicate_override, true);
});

test("staff outbound surfaces likelyDuplicateRegNo from RPC error", async () => {
  const attempt = newAttempt();
  const result = await submitRegistrationOutbound({
    isStaff: true,
    attempt,
    staffFields,
    rpc: async () => ({
      data: null,
      error: { message: "LIKELY_DUPLICATE:reg=314" },
    }),
  });
  assert.equal(result.likelyDuplicateRegNo, 314);
  assert.match(String(result.error), /LIKELY_DUPLICATE:reg=314/);
});
