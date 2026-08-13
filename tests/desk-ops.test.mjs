/**
 * Desk scan / mark-seen / change-day retry + idempotency behaviour (#32, #60).
 * Transient failures use structured SQLSTATE / transport shapes — not English regex alone.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  markSeenWithRetries,
  changeCampDayWithRetries,
  printPrescriptionWithRetries,
  lookupPatientScanWithRetries,
  searchRegisteredPatientsWithRetries,
  searchDeskPatientsWithRetries,
  undoMarkSeenWithRetries,
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
            seen_by_name: null,
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

test("mark seen retries twice on timeout then surfaces exhausted copy", async () => {
  let calls = 0;
  const result = await markSeenWithRetries({
    patientId: "p1",
    rpc: async () => {
      calls += 1;
      return { data: null, error: { ...TRANSIENT_TIMEOUT } };
    },
    sleep,
  });
  assert.equal(calls, 3);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, RETRY_EXHAUSTED_COPY.markSeen);
});

test("mark seen already_seen after a flaky first call is terminal success", async () => {
  // The first call landed server-side; the retry must report the ORIGINAL
  // seen_at/seen_by rather than re-stamping the row (D25 double-scan safety).
  let calls = 0;
  const result = await markSeenWithRetries({
    patientId: "p1",
    rpc: async () => {
      calls += 1;
      if (calls === 1) return { data: null, error: { ...TRANSIENT_TIMEOUT } };
      return {
        data: [
          {
            id: "p1",
            reg_no: 7,
            full_name: "Pat",
            queue_status: "seen",
            seen_at: "2026-07-28T10:00:00Z",
            seen_by_name: "Original Volunteer",
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
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.row.already_seen, true);
  assert.equal(result.row.seen_by_name, "Original Volunteer");
  assert.equal(result.row.seen_at, "2026-07-28T10:00:00Z");
});

test("mark seen never_printed is not retried and names the reason", async () => {
  let calls = 0;
  const result = await markSeenWithRetries({
    patientId: "p1",
    rpc: async () => {
      calls += 1;
      return {
        data: [
          {
            id: "p1",
            reg_no: 1,
            full_name: "A",
            queue_status: "registered",
            seen_at: null,
            seen_by_name: null,
            already_seen: false,
            error_code: "never_printed",
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
  assert.equal(result.neverPrinted, true);
  assert.match(result.error, /print/i);
  assert.doesNotMatch(result.error, /network|timeout|PGRST|postgres/i);
});

test("undo mark seen surfaces an expired window as a terminal, plain message", async () => {
  let calls = 0;
  const result = await undoMarkSeenWithRetries({
    patientId: "p1",
    rpc: async () => {
      calls += 1;
      return {
        data: [
          {
            id: "p1",
            reg_no: 1,
            full_name: "A",
            queue_status: "seen",
            error_code: "undo_window_expired",
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
  assert.match(result.error, /too late/i);
  assert.doesNotMatch(result.error, /network|timeout|PGRST|postgres/i);
});

test("undo mark seen explains that an inactive camp cannot be reopened", async () => {
  const result = await undoMarkSeenWithRetries({
    patientId: "p1",
    rpc: async () => ({
      data: [
        {
          id: "p1",
          reg_no: 1,
          full_name: "A",
          queue_status: "seen",
          error_code: "inactive_camp",
        },
      ],
      error: null,
    }),
    sleep,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /no longer active/i);
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
// Print prescription + lost-slip search (#61, ADR 0013)
// ---------------------------------------------------------------------------

test("print retries twice on 08006 then surfaces exhausted copy", async () => {
  let calls = 0;
  const result = await printPrescriptionWithRetries({
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
  assert.equal(result.error, RETRY_EXHAUSTED_COPY.printPrescription);
});

test("print calls mark_patient_printed and succeeds after serialization_failure", async () => {
  let calls = 0;
  /** @type {unknown[]} */
  const patientArgs = [];
  /** @type {string[]} */
  const fns = [];
  const result = await printPrescriptionWithRetries({
    patientId: "p-fixed",
    rpc: async (fn, args) => {
      calls += 1;
      fns.push(fn);
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
            queue_status: "registered",
            already_printed: false,
          },
        ],
        error: null,
      };
    },
    sleep,
  });
  assert.equal(calls, 2);
  assert.deepEqual(fns, ["mark_patient_printed", "mark_patient_printed"]);
  assert.deepEqual(patientArgs, ["p-fixed", "p-fixed"]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.row.reg_no, 42);
  assert.equal(result.row.already_printed, false);
});

test("a seen patient may still be reprinted — print never refuses on status", async () => {
  let calls = 0;
  const result = await printPrescriptionWithRetries({
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
            already_printed: true,
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
  assert.equal(result.row.already_printed, true);
  assert.equal(result.row.queue_status, "seen");
});

test("print permission denial is not retried and hides raw text", async () => {
  let calls = 0;
  const result = await printPrescriptionWithRetries({
    patientId: "p1",
    rpc: async () => {
      calls += 1;
      return {
        data: null,
        error: {
          code: "42501",
          message: "permission denied for function mark_patient_printed",
        },
      };
    },
    sleep,
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /permission/i);
  assert.doesNotMatch(result.error, /mark_patient_printed|42501/i);
});

test("a reprint reports already_printed and is not retried", async () => {
  let calls = 0;
  const result = await printPrescriptionWithRetries({
    regNo: 5,
    rpc: async () => {
      calls += 1;
      return {
        data: [
          {
            id: "p5",
            reg_no: 5,
            full_name: "Reprint",
            queue_status: "registered",
            already_printed: true,
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
  assert.equal(result.row.already_printed, true);
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

test("unified desk search calls the all-status RPC and preserves queue state", async () => {
  const result = await searchDeskPatientsWithRetries({
    campId: "c1",
    query: "ramesh",
    rpc: async (fn, args) => {
      assert.equal(fn, "search_desk_patients");
      assert.equal(args.p_camp_id, "c1");
      return {
        data: [{
          id: "p1",
          reg_no: 7,
          full_name: "Ramesh",
          age: 44,
          address: "Sikar",
          queue_status: "waiting",
        }],
        error: null,
      };
    },
    sleep,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rows[0].queue_status, "waiting");
});

