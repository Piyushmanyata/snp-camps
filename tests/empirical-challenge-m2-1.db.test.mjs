/**
 * Empirical database-integration stress tests for lost-slip search and
 * idempotent check-in (#61).
 *
 * Split out of empirical-challenge-m2-1.test.mjs: these need a live Postgres,
 * and a DB test that skips is a failure, not a pass (AGENTS.md). Only the
 * .db.test.mjs suffix puts them under the zero-skip guard in
 * scripts/run-db-tests.mjs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";

import {
  searchRegisteredPatientsWithRetries,
} from "../src/lib/desk-ops.ts";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const VENUE = "m2-1-empirical-challenge";

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
    const { rows: todayRows } = await client.query(
      `select (timezone('Asia/Kolkata', now()))::date as d`,
    );
    await client.query(
      `insert into public.camp_days (id, camp_id, day_date, seat_limit, printing_open) values ($1, $2, $3, 100, true)`,
      [futureDayId, campId, todayRows[0].d],
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
