/**
 * Behavioural coverage for registration idempotency / requestId outbound paths.
 * Exercises the same module PatientForm uses to call the API and staff RPC.
 * Deliberately does not grep component source for the string "requestId".
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createRegistrationAttempt,
  publicRegistrationBody,
  staffRegistrationRpcArgs,
  submitRegistrationOutbound,
} from "../src/lib/registration-request.ts";
import { createRequestId } from "../src/lib/request-id.ts";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function newAttempt() {
  return createRegistrationAttempt(createRequestId);
}

const publicFields = {
  campId: "11111111-1111-4111-8111-111111111111",
  campDayId: "22222222-2222-4222-8222-222222222222",
  fullName: "Test Patient",
  gender: "F",
  age: 30,
  address: "1 Test St",
  phone: "9876543210",
  email: null,
  aadhaarLast4: "1234",
};

const staffFields = {
  campId: publicFields.campId,
  fullName: publicFields.fullName,
  gender: publicFields.gender,
  age: publicFields.age,
  address: publicFields.address,
  phone: publicFields.phone,
  email: null,
  aadhaarLast4: "1234",
  userId: "33333333-3333-4333-8333-333333333333",
  createdBy: "44444444-4444-4444-8444-444444444444",
  campDayId: publicFields.campDayId,
};

test("public registration submit sends a non-empty UUID requestId to the API", async () => {
  const attempt = newAttempt();
  /** @type {unknown} */
  let capturedBody = null;

  const result = await submitRegistrationOutbound({
    isStaff: false,
    attempt,
    publicFields,
    fetchImpl: async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          patient: { id: "p1", reg_no: 1, full_name: publicFields.fullName },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  assert.equal(result.error, null);
  assert.ok(capturedBody && typeof capturedBody === "object");
  const body = /** @type {{ requestId?: string }} */ (capturedBody);
  assert.equal(typeof body.requestId, "string");
  assert.ok(body.requestId.length > 0, "requestId must be non-empty");
  assert.match(body.requestId, UUID_V4);
  assert.equal(body.requestId, attempt.id);
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
});

test("requestId is stable across retries of the same submission", async () => {
  const attempt = newAttempt();
  const ids = [];

  for (let i = 0; i < 3; i += 1) {
    await submitRegistrationOutbound({
      isStaff: false,
      attempt,
      publicFields,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        ids.push(body.requestId);
        return new Response(JSON.stringify({ error: "temporary" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
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
    isStaff: false,
    attempt,
    publicFields,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          patient: { id: "p1", reg_no: 1, full_name: "X" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
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

test("public and staff payload builders include the attempt id (not optional)", () => {
  const attempt = createRegistrationAttempt(
    () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  );
  const publicBody = publicRegistrationBody(attempt, publicFields);
  const staffArgs = staffRegistrationRpcArgs(attempt, staffFields);

  assert.equal(publicBody.requestId, attempt.id);
  assert.equal(staffArgs.p_request_id, attempt.id);
  // API rejects missing/invalid UUIDs — builders must not drop the field.
  assert.equal(
    Object.prototype.hasOwnProperty.call(publicBody, "requestId"),
    true,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(staffArgs, "p_request_id"),
    true,
  );
});
