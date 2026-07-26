/**
 * Desk scan / assign / change-day retry + idempotency behaviour (#32).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  assignPatientDoctorWithRetries,
  changeCampDayWithRetries,
  lookupPatientScanWithRetries,
} from "../src/lib/desk-ops.ts";
import { RETRY_EXHAUSTED_COPY } from "../src/lib/with-retries.ts";

const sleep = async () => {};
const mapRpcError = (m) => m || "mapped";

test("lookup retries twice then surfaces exhausted copy", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await lookupPatientScanWithRetries({
    patientId: "p1",
    rpc: async () => {
      calls += 1;
      return { data: null, error: { message: "network" } };
    },
    mapRpcError,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [250, 750]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, RETRY_EXHAUSTED_COPY.lookup);
});

test("lookup success on second attempt", async () => {
  let calls = 0;
  const result = await lookupPatientScanWithRetries({
    regNo: 12,
    rpc: async () => {
      calls += 1;
      if (calls === 1) return { data: null, error: { message: "blip" } };
      return {
        data: [
          {
            id: "p1",
            reg_no: 12,
            full_name: "A",
            queue_status: "waiting",
            phone: null,
            doctor_id: null,
            doctor_name: null,
          },
        ],
        error: null,
      };
    },
    mapRpcError,
    sleep,
  });
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.row.reg_no, 12);
});

test("lookup patient-not-found is not retried", async () => {
  let calls = 0;
  const result = await lookupPatientScanWithRetries({
    regNo: 99,
    rpc: async () => {
      calls += 1;
      return { data: [], error: null };
    },
    mapRpcError,
    sleep,
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.notFound, true);
});

test("assign retries twice then surfaces exhausted copy", async () => {
  let calls = 0;
  const result = await assignPatientDoctorWithRetries({
    patientId: "p1",
    doctorId: "doc-a",
    rpc: async () => {
      calls += 1;
      return { data: null, error: { message: "timeout" } };
    },
    mapRpcError,
    sleep,
  });
  assert.equal(calls, 3);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, RETRY_EXHAUSTED_COPY.assign);
});

test("assign keeps the same doctor id on every retry (no double-assign params)", async () => {
  /** @type {unknown[]} */
  const doctorArgs = [];
  let calls = 0;
  await assignPatientDoctorWithRetries({
    patientId: "p1",
    doctorId: "doc-fixed",
    rpc: async (_fn, args) => {
      calls += 1;
      doctorArgs.push(args.p_doctor_id);
      return { data: null, error: { message: "network" } };
    },
    mapRpcError,
    sleep,
  });
  assert.equal(calls, 3);
  assert.deepEqual(doctorArgs, ["doc-fixed", "doc-fixed", "doc-fixed"]);
});

test("assign already_seen after flaky first call is terminal success (no re-assign)", async () => {
  let calls = 0;
  /** @type {string[]} */
  const doctors = [];
  const result = await assignPatientDoctorWithRetries({
    patientId: "p1",
    doctorId: "doc-b",
    rpc: async (_fn, args) => {
      calls += 1;
      doctors.push(/** @type {string} */ (args.p_doctor_id));
      if (calls === 1) return { data: null, error: { message: "timeout" } };
      // Server: first call actually landed; second returns already_seen with original doctor.
      return {
        data: [
          {
            id: "p1",
            reg_no: 7,
            full_name: "Pat",
            queue_status: "seen",
            doctor_id: "doc-original",
            doctor_name: "Dr Original",
            already_seen: true,
            error_code: "already_seen",
          },
        ],
        error: null,
      };
    },
    mapRpcError,
    sleep,
  });
  assert.equal(calls, 2);
  assert.deepEqual(doctors, ["doc-b", "doc-b"]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.row.already_seen, true);
  assert.equal(result.row.doctor_id, "doc-original");
});

test("assign doctor_required is not retried", async () => {
  let calls = 0;
  const result = await assignPatientDoctorWithRetries({
    patientId: "p1",
    doctorId: null,
    rpc: async () => {
      calls += 1;
      return {
        data: [
          {
            id: "p1",
            reg_no: 1,
            full_name: "A",
            queue_status: "waiting",
            doctor_id: null,
            doctor_name: null,
            already_seen: false,
            error_code: "doctor_required",
          },
        ],
        error: null,
      };
    },
    mapRpcError,
    sleep,
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.doctorRequired, true);
});

test("change-day retries twice then surfaces exhausted copy", async () => {
  let calls = 0;
  const result = await changeCampDayWithRetries({
    patientId: "p1",
    newDayId: "d2",
    rpc: async () => {
      calls += 1;
      throw new Error("Failed to fetch");
    },
    mapRpcError,
    sleep,
  });
  assert.equal(calls, 3);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, RETRY_EXHAUSTED_COPY.changeDay);
});

test("change-day business error (full) is not retried", async () => {
  let calls = 0;
  const result = await changeCampDayWithRetries({
    patientId: "p1",
    newDayId: "d2",
    rpc: async () => {
      calls += 1;
      return {
        data: null,
        error: { message: "That day is full (40 seats taken)" },
      };
    },
    mapRpcError,
    sleep,
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /full/i);
});

test("change-day success on second attempt preserves day id arg", async () => {
  let calls = 0;
  /** @type {string[]} */
  const dayIds = [];
  const result = await changeCampDayWithRetries({
    patientId: "p1",
    newDayId: "day-target",
    rpc: async (_fn, args) => {
      calls += 1;
      dayIds.push(/** @type {string} */ (args.p_new_day_id));
      if (calls === 1) return { data: null, error: { message: "network" } };
      return {
        data: [
          {
            id: "p1",
            reg_no: 3,
            full_name: "A",
            camp_day_id: "day-target",
            day_date: "2026-08-01",
          },
        ],
        error: null,
      };
    },
    mapRpcError,
    sleep,
  });
  assert.equal(calls, 2);
  assert.deepEqual(dayIds, ["day-target", "day-target"]);
  assert.equal(result.ok, true);
});
