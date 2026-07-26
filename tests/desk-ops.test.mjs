/**
 * Desk scan / assign / change-day retry + idempotency behaviour (#32, #60).
 * Transient failures use structured SQLSTATE / transport shapes — not English regex alone.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  assignPatientDoctorWithRetries,
  changeCampDayWithRetries,
  checkInPatientWithRetries,
  lookupPatientScanWithRetries,
  searchRegisteredPatientsWithRetries,
} from "../src/lib/desk-ops.ts";
import { RETRY_EXHAUSTED_COPY } from "../src/lib/with-retries.ts";

const sleep = async () => {};

/** Representative connection-class error (retryable). */
const TRANSIENT_CONN = {
  code: "08006",
  message: "connection_failure",
};

/** Statement timeout (retryable). */
const TRANSIENT_TIMEOUT = {
  code: "57014",
  message: "canceling statement due to statement timeout",
};

test("lookup retries twice on 08006 then surfaces exhausted copy", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await lookupPatientScanWithRetries({
    patientId: "p1",
    rpc: async () => {
      calls += 1;
      return { data: null, error: { ...TRANSIENT_CONN } };
    },
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

test("lookup success on second attempt after serialization_failure", async () => {
  let calls = 0;
  const result = await lookupPatientScanWithRetries({
    regNo: 12,
    rpc: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          data: null,
          error: { code: "40001", message: "could not serialize access" },
        };
      }
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
    sleep,
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.notFound, true);
});

test("lookup permission denial 42501 is not retried", async () => {
  let calls = 0;
  const result = await lookupPatientScanWithRetries({
    patientId: "p1",
    rpc: async () => {
      calls += 1;
      return {
        data: null,
        error: {
          code: "42501",
          message: "permission denied for table patients",
        },
      };
    },
    sleep,
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /permission/i);
  assert.doesNotMatch(result.error, /patients|42501|internet/i);
});

test("assign retries twice on timeout then surfaces exhausted copy", async () => {
  let calls = 0;
  const result = await assignPatientDoctorWithRetries({
    patientId: "p1",
    doctorId: "doc-a",
    rpc: async () => {
      calls += 1;
      return { data: null, error: { ...TRANSIENT_TIMEOUT } };
    },
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
      return { data: null, error: { ...TRANSIENT_CONN } };
    },
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
      if (calls === 1) return { data: null, error: { ...TRANSIENT_TIMEOUT } };
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
    sleep,
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.doctorRequired, true);
});

test("assign check_in_required is not retried and uses worker copy", async () => {
  let calls = 0;
  const result = await assignPatientDoctorWithRetries({
    patientId: "p1",
    doctorId: "doc-a",
    rpc: async () => {
      calls += 1;
      return {
        data: [
          {
            id: "p1",
            reg_no: 1,
            full_name: "A",
            queue_status: "registered",
            doctor_id: null,
            doctor_name: null,
            already_seen: false,
            error_code: "check_in_required",
          },
        ],
        error: null,
      };
    },
    sleep,
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.checkInRequired, true);
  assert.match(result.error, /check.+in first/i);
  assert.doesNotMatch(result.error, /network|timeout|PGRST|postgres/i);
});

test("change-day retries twice on thrown transport then surfaces exhausted copy", async () => {
  let calls = 0;
  const result = await changeCampDayWithRetries({
    patientId: "p1",
    newDayId: "d2",
    rpc: async () => {
      calls += 1;
      throw new Error("Failed to fetch");
    },
    sleep,
  });
  assert.equal(calls, 3);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, RETRY_EXHAUSTED_COPY.changeDay);
});

test("change-day business error (day full P0001) is not retried", async () => {
  let calls = 0;
  const result = await changeCampDayWithRetries({
    patientId: "p1",
    newDayId: "d2",
    rpc: async () => {
      calls += 1;
      return {
        data: null,
        error: {
          code: "P0001",
          message: "That day is full (40 seats taken)",
        },
      };
    },
    sleep,
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /full/i);
  assert.doesNotMatch(result.error, /internet|Failed to fetch|P0001/i);
});

test("change-day RLS denial is not retried", async () => {
  let calls = 0;
  const result = await changeCampDayWithRetries({
    patientId: "p1",
    newDayId: "d2",
    rpc: async () => {
      calls += 1;
      return {
        data: null,
        error: {
          code: "42501",
          message: "permission denied for function change_camp_day",
        },
      };
    },
    sleep,
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /permission/i);
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
      if (calls === 1) return { data: null, error: { ...TRANSIENT_CONN } };
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
    sleep,
  });
  assert.equal(calls, 2);
  assert.deepEqual(dayIds, ["day-target", "day-target"]);
  assert.equal(result.ok, true);
});

test("change-day unknown XX000 is terminal (not three internet retries)", async () => {
  let calls = 0;
  const result = await changeCampDayWithRetries({
    patientId: "p1",
    newDayId: "d2",
    rpc: async () => {
      calls += 1;
      return {
        data: null,
        error: { code: "XX000", message: "weird internal" },
      };
    },
    sleep,
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.doesNotMatch(result.error, /internet|weird internal/i);
});

// ---------------------------------------------------------------------------
// #61 — check-in + lost-slip search
// ---------------------------------------------------------------------------

test("check-in retries twice on 08006 then surfaces exhausted copy", async () => {
  let calls = 0;
  const result = await checkInPatientWithRetries({
    patientId: "p1",
    rpc: async () => {
      calls += 1;
      return { data: null, error: { ...TRANSIENT_CONN } };
    },
    sleep,
  });
  assert.equal(calls, 3);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, RETRY_EXHAUSTED_COPY.checkIn);
});

test("check-in success on second attempt after serialization_failure", async () => {
  let calls = 0;
  /** @type {unknown[]} */
  const patientArgs = [];
  const result = await checkInPatientWithRetries({
    patientId: "p-fixed",
    rpc: async (_fn, args) => {
      calls += 1;
      patientArgs.push(args.p_patient_id);
      if (calls === 1) {
        return {
          data: null,
          error: { code: "40001", message: "could not serialize access" },
        };
      }
      return {
        data: [
          {
            id: "p-fixed",
            reg_no: 42,
            full_name: "Sita Devi",
            queue_status: "waiting",
            already_waiting: false,
            doctor_name: null,
            error_code: null,
          },
        ],
        error: null,
      };
    },
    sleep,
  });
  assert.equal(calls, 2);
  assert.deepEqual(patientArgs, ["p-fixed", "p-fixed"]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.row.reg_no, 42);
  assert.equal(result.row.already_waiting, false);
});

test("check-in already_seen is terminal and uses safe copy", async () => {
  let calls = 0;
  const result = await checkInPatientWithRetries({
    regNo: 9,
    rpc: async () => {
      calls += 1;
      return {
        data: [
          {
            id: "p9",
            reg_no: 9,
            full_name: "Seen Pat",
            queue_status: "seen",
            already_waiting: false,
            doctor_name: "Dr Mehta",
            error_code: "already_seen",
          },
        ],
        error: null,
      };
    },
    sleep,
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.alreadySeen, true);
  assert.match(result.error, /Already seen by Dr Mehta/);
  assert.doesNotMatch(result.error, /postgres|PGRST|relation/i);
});

test("check-in permission denial is not retried and hides raw text", async () => {
  let calls = 0;
  const result = await checkInPatientWithRetries({
    patientId: "p1",
    rpc: async () => {
      calls += 1;
      return {
        data: null,
        error: {
          code: "42501",
          message: "permission denied for function check_in_patient",
        },
      };
    },
    sleep,
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /permission/i);
  assert.doesNotMatch(result.error, /check_in_patient|42501/i);
});

test("check-in already_waiting success is not retried", async () => {
  let calls = 0;
  const result = await checkInPatientWithRetries({
    regNo: 5,
    rpc: async () => {
      calls += 1;
      return {
        data: [
          {
            id: "p5",
            reg_no: 5,
            full_name: "Waiting",
            queue_status: "waiting",
            already_waiting: true,
            doctor_name: null,
            error_code: null,
          },
        ],
        error: null,
      };
    },
    sleep,
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.row.already_waiting, true);
});

test("search empty rows is success empty — not an error (#61)", async () => {
  let calls = 0;
  const result = await searchRegisteredPatientsWithRetries({
    campId: "c1",
    query: "nobody",
    rpc: async () => {
      calls += 1;
      return { data: [], error: null };
    },
    sleep,
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.rows, []);
});

test("search RLS / permission is error not empty match", async () => {
  let calls = 0;
  const result = await searchRegisteredPatientsWithRetries({
    campId: "c1",
    query: "ramesh",
    rpc: async () => {
      calls += 1;
      return {
        data: null,
        error: {
          code: "42501",
          message: "permission denied for function search_registered_patients",
        },
      };
    },
    sleep,
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /permission/i);
  assert.doesNotMatch(result.error, /search_registered|no registered|match/i);
});

test("search transport failure retries then exhausted copy", async () => {
  let calls = 0;
  const result = await searchRegisteredPatientsWithRetries({
    campId: "c1",
    query: "sita",
    rpc: async () => {
      calls += 1;
      throw new Error("Failed to fetch");
    },
    sleep,
  });
  assert.equal(calls, 3);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, RETRY_EXHAUSTED_COPY.search);
});

test("search success on second attempt returns rows", async () => {
  let calls = 0;
  const result = await searchRegisteredPatientsWithRetries({
    campId: "c1",
    query: "ram",
    rpc: async () => {
      calls += 1;
      if (calls === 1) {
        return { data: null, error: { ...TRANSIENT_TIMEOUT } };
      }
      return {
        data: [
          {
            id: "p1",
            reg_no: 1,
            full_name: "Ramesh Kumar",
            age: 45,
            address: "Sikar",
          },
        ],
        error: null,
      };
    },
    sleep,
  });
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].full_name, "Ramesh Kumar");
});

test("search unknown XX000 is terminal error not empty", async () => {
  let calls = 0;
  const result = await searchRegisteredPatientsWithRetries({
    campId: "c1",
    query: "x",
    rpc: async () => {
      calls += 1;
      return {
        data: null,
        error: { code: "XX000", message: "relation patients exploded" },
      };
    },
    sleep,
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.doesNotMatch(result.error, /exploded|relation patients/i);
});
