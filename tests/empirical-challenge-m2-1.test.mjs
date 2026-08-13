/**
 * Empirical Stress Test Harness for #60 (Desk Failure Retries),
 * #61 (Lost-Slip Search & Idempotent Check-in), and
 * #62 (Register & Print Popup Blocker Survival).
 *
 * Written by Challenger M2-1 for empirical verification.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";

import {
  classifyOperationError,
} from "../src/lib/public-error.ts";

import {
  lookupPatientScanWithRetries,
  changeCampDayWithRetries,
  searchRegisteredPatientsWithRetries,
} from "../src/lib/desk-ops.ts";

import {
  acquireDeskPrintTarget,
  runDeskRegisterAndPrint,
} from "../src/lib/desk-register-flow.ts";

import { RETRY_EXHAUSTED_COPY } from "../src/lib/with-retries.ts";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const VENUE = "m2-1-empirical-challenge";

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

// --------------------------------------------------------------------------
// SECTION 3: DATABASE INTEGRATION FOR LOST-SLIP SEARCH & CHECK-IN (#61)
// --------------------------------------------------------------------------

/** @type {pg.Client | null} */
let client = null;
let dbAvailable = false;

async function connectDb() {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await c.connect();
    const { rows } = await c.query(
      `select to_regprocedure('public.search_registered_patients(uuid,text,integer)') is not null as ok`
    );
    if (!rows[0]?.ok) {
      await c.end();
      return null;
    }
    return c;
  } catch {
    try {
      await c.end();
    } catch {
      /* ignore */
    }
    return null;
  }
}

test.before(async () => {
  client = await connectDb();
  dbAvailable = Boolean(client);
});

test.after(async () => {
  if (client) {
    try {
      await client.query(`update public.camps set is_active = false where is_active = true`);
    } catch {
      /* ignore */
    }
    await client.end();
  }
});

function skipIfNoDb(t) {
  if (!dbAvailable) {
    t.skip("local Postgres not available");
    return true;
  }
  return false;
}

async function asServiceRole(fn) {
  await client.query("begin");
  try {
    await client.query(`select set_config('request.jwt.claim.role', 'service_role', true)`);
    const result = await fn();
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

async function asStaff(userId, fn) {
  await client.query("begin");
  try {
    await client.query(`select set_config('request.jwt.claim.role', 'authenticated', true)`);
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ role: "authenticated", sub: userId }),
    ]);
    const result = await fn();
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

async function seedVolunteer() {
  const userId = randomUUID();
  await client.query(
    `insert into auth.users (
       id, instance_id, aud, role, email,
       encrypted_password, email_confirmed_at,
       raw_app_meta_data, raw_user_meta_data,
       created_at, updated_at
     ) values (
       $1, '00000000-0000-0000-0000-000000000000',
       'authenticated', 'authenticated',
       $2, crypt('test-password-long', gen_salt('bf')),
       now(), '{"provider":"email"}'::jsonb, '{}'::jsonb,
       now(), now()
     )`,
    [userId, `vol-m21-${userId.slice(0, 8)}@example.test`]
  );
  await client.query(
    `insert into public.profiles (id, role, full_name, email)
     values ($1, 'volunteer', 'M2-1 Vol', $2)
     on conflict (id) do update set role = 'volunteer'`,
    [userId, `vol-m21-${userId.slice(0, 8)}@example.test`]
  );
  return userId;
}

async function seedCamp() {
  const campId = randomUUID();
  const futureDayId = randomUUID();
  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock(918273648)");
    await client.query(
      `delete from public.patients where camp_id in (select id from public.camps where venue = $1)`,
      [VENUE]
    );
    await client.query(
      `delete from public.camp_days where camp_id in (select id from public.camps where venue = $1)`,
      [VENUE]
    );
    await client.query(`delete from public.camps where venue = $1`, [VENUE]);
    await client.query(`update public.camps set is_active = false where is_active = true`);
    await client.query(
      `insert into public.camps (id, name, is_active, venue) values ($1, $2, true, $3)`,
      [campId, `M2-1 Camp ${campId.slice(0, 8)}`, VENUE]
    );
    await client.query(
      `insert into public.camp_days (id, camp_id, day_date, seat_limit) values ($1, $2, '2099-11-15', 100)`,
      [futureDayId, campId]
    );
    await client.query(`update public.camps set is_active = (id = $1)`, [campId]);
    await client.query("commit");
    return { campId, futureDayId };
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

test("STRESS #61: Search truthful empty handling vs permission error", async () => {
  // Empty query with mock RPC returning no rows
  const mockEmptyRpc = async () => ({ data: [], error: null });
  const emptyRes = await searchRegisteredPatientsWithRetries({
    campId: randomUUID(),
    query: "NonExistentNameQueryXYZ",
    rpc: mockEmptyRpc,
  });

  assert.equal(emptyRes.ok, true);
  assert.deepEqual(emptyRes.rows, []);

  // Permission error must NOT collapse to empty rows
  const mockErrRpc = async () => ({
    data: null,
    error: { code: "42501", message: "permission denied for function search_registered_patients" },
  });
  const errRes = await searchRegisteredPatientsWithRetries({
    campId: randomUUID(),
    query: "ramesh",
    rpc: mockErrRpc,
  });

  assert.equal(errRes.ok, false);
  assert.equal(errRes.error, "You do not have permission for this action.");
});

test("STRESS #61: Trigram ranking edge cases (typos, exact prefix, case-insensitivity)", async (t) => {
  if (skipIfNoDb(t)) return;

  const staffId = await seedVolunteer();
  const { campId, futureDayId } = await seedCamp();

  // Seed patients
  await asServiceRole(async () => {
    // Exact prefix match
    await client.query(
      `select * from public.register_patient_idempotent($1, $2, 'Vikram Singh', 'M', 35, 'Ward 5', null, null, null, null, $3, $4, false, false, false, 'self_declared', null, null, null)`,
      [randomUUID(), campId, staffId, futureDayId]
    );
    // 1-character typo
    await client.query(
      `select * from public.register_patient_idempotent($1, $2, 'Vickram Sharma', 'M', 38, 'Ward 6', null, null, null, null, $3, $4, false, false, false, 'self_declared', null, null, null)`,
      [randomUUID(), campId, staffId, futureDayId]
    );
    // Transposition in full name
    await client.query(
      `select * from public.register_patient_idempotent($1, $2, 'Priya Sharma', 'F', 28, 'Nawalgarh', null, null, null, null, $3, $4, false, false, false, 'self_declared', null, null, null)`,
      [randomUUID(), campId, staffId, futureDayId]
    );
  });

  // Query 1: "vikram" (case-insensitive search)
  const results = await asStaff(staffId, async () => {
    const { rows } = await client.query(
      `select * from public.search_registered_patients($1, 'vikram', 10)`,
      [campId]
    );
    return rows;
  });

  assert.ok(results.length >= 1, "Expected results for search 'vikram'");
  assert.equal(results[0].full_name, "Vikram Singh", "Exact prefix match 'Vikram Singh' must rank first!");
  assert.ok(results.some((r) => r.full_name === "Vickram Sharma"), "1-character typo match present");

  // Query 2: Transposition query "pirya sharma" -> "Priya Sharma"
  const transpositionResults = await asStaff(staffId, async () => {
    const { rows } = await client.query(
      `select * from public.search_registered_patients($1, 'pirya sharma', 10)`,
      [campId]
    );
    return rows;
  });

  assert.ok(
    transpositionResults.some((r) => r.full_name === "Priya Sharma"),
    "Transposition match present for pirya sharma -> Priya Sharma"
  );
});

test("STRESS #61: printing for a lost-slip patient records presence once", async (t) => {
  if (skipIfNoDb(t)) return;

  const staffId = await seedVolunteer();
  const { campId, futureDayId } = await seedCamp();

  const regPatient = await asServiceRole(async () => {
    const { rows } = await client.query(
      `select * from public.register_patient_idempotent($1, $2, 'Lost Slip Patient', 'F', 29, 'Locality C', null, null, null, null, $3, $4, false, false, false, 'self_declared', null, null, null)`,
      [randomUUID(), campId, staffId, futureDayId]
    );
    return rows[0];
  });

  assert.equal(regPatient.queue_status, "registered");

  // Recovering a lost slip = print the prescription again.
  const printRes = await asStaff(staffId, async () => {
    const { rows } = await client.query(
      `select * from public.mark_patient_printed($1, null)`,
      [regPatient.id]
    );
    return rows[0];
  });

  assert.equal(printRes.queue_status, "registered");
  assert.equal(printRes.already_printed, false);

  const { rows: dbRows } = await client.query(
    `select queue_status, queued_at, printed_at from public.patients where id = $1`,
    [regPatient.id]
  );

  assert.equal(dbRows[0].queue_status, "registered");
  assert.ok(dbRows[0].printed_at !== null, "printed_at must be set on print");
  assert.equal(dbRows[0].queued_at, null, "printing writes no line time");
});
