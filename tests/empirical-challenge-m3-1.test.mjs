/**
 * Empirical Stress Test Harness for Milestone 3 (P1 Operations & Serialization #65-#68).
 * Written by Challenger M3-1 (challenger_m3_1_v11) for final empirical verification.
 *
 * Covers:
 *  - #65: SMS Delivery State & Concurrent Claiming
 *  - #66: High-Concurrency Camp-Day Capacity Serialization & Limit Invariants
 *  - #67: High-Concurrency Soft Likely-Duplicate Serialization & Staff Override
 *  - #68: Migration Readiness Contract & Catalog Probe Verification
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXPECTED_MIGRATION_HEAD,
} from "../src/lib/readiness-contract.ts";
import { evaluateCatalogFacts } from "../src/lib/readiness.ts";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @type {pg.Client | null} */
let admin = null;
let dbAvailable = false;

async function connect() {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await c.connect();
    const { rows } = await c.query(
      `select
         to_regprocedure('public.upsert_camp_day(uuid,date,integer,uuid)') is not null
         and to_regprocedure(
           'public.register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean)'
         ) is not null
         and to_regprocedure('public.readiness_catalog_probe()') is not null as ok`,
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
  admin = await connect();
  dbAvailable = Boolean(admin);
  if (!dbAvailable) {
    console.warn(
      "[empirical-challenge-m3-1] local Postgres unavailable — skipping DB stress tests",
    );
  }
});

test.after(async () => {
  if (admin) await admin.end();
});

function skipIfNoDb(t) {
  if (!dbAvailable) {
    t.skip("local Postgres not available");
    return true;
  }
  return false;
}

function newClient() {
  return new pg.Client({ connectionString: DATABASE_URL });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function setAuth(c, userId, role = "authenticated") {
  await c.query(
    `select set_config('request.jwt.claim.role', $1, true)`,
    [role],
  );
  await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
    userId,
  ]);
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ role, sub: userId }),
  ]);
}

async function register(c, args) {
  const {
    requestId,
    campId,
    dayId,
    fullName,
    age = 40,
    phone = null,
    aadhaarLast4 = null,
    aadhaarOverride = false,
    likelyOverride = false,
  } = args;
  const { rows } = await c.query(
    `select id, reg_no, full_name, queue_status
     from public.register_patient_idempotent(
       $1::uuid, $2::uuid, $3::text,
       'M', $4::integer, 'Addr', $5::text, null, $6::text,
       null, null, $7::uuid, $8::boolean, $9::boolean
     )`,
    [
      requestId,
      campId,
      fullName,
      age,
      phone,
      aadhaarLast4,
      dayId,
      aadhaarOverride,
      likelyOverride,
    ],
  );
  return rows[0];
}

async function upsertDay(c, args) {
  const { campId, dayDate, seatLimit, dayId = null } = args;
  const { rows } = await c.query(
    `select id, camp_id, day_date, seat_limit
     from public.upsert_camp_day(
       $1::uuid, $2::date, $3::integer, $4::uuid
     )`,
    [campId, dayDate, seatLimit, dayId],
  );
  return rows[0];
}

async function seedCampWithDays(numDays = 2, seatLimit = 50) {
  const campId = randomUUID();
  const days = [];
  await admin.query("begin");
  try {
    await admin.query("select pg_advisory_xact_lock(987654321)");
    await admin.query(
      `update public.camps set is_active = false where is_active = true`,
    );
    await admin.query(
      `insert into public.camps (id, name, is_active, venue)
       values ($1, $2, true, 'm3-1-empirical')`,
      [campId, `M3-1 Camp ${campId.slice(0, 8)}`],
    );
    for (let i = 1; i <= numDays; i++) {
      const dayId = randomUUID();
      const dayDate = `2099-12-0${i}`;
      await admin.query(
        `insert into public.camp_days (id, camp_id, day_date, seat_limit)
         values ($1, $2, $3::date, $4)`,
        [dayId, campId, dayDate, seatLimit],
      );
      days.push({ dayId, dayDate });
    }
    await admin.query("commit");
  } catch (err) {
    await admin.query("rollback");
    throw err;
  }
  return { campId, days };
}

async function cleanupCamp(campId) {
  await admin.query(
    `delete from public.sms_deliveries where patient_id in (
       select id from public.patients where camp_id = $1
     )`,
    [campId],
  );
  await admin.query(`delete from public.patients where camp_id = $1`, [campId]);
  await admin.query(`delete from public.camp_days where camp_id = $1`, [campId]);
  await admin.query(`delete from public.camps where id = $1`, [campId]);
}

async function seedStaff(role = "volunteer") {
  const userId = randomUUID();
  await admin.query(
    `insert into auth.users (
       id, instance_id, aud, role, email,
       encrypted_password, email_confirmed_at,
       raw_app_meta_data, raw_user_meta_data,
       created_at, updated_at
     ) values (
       $1, '00000000-0000-0000-0000-000000000000',
       'authenticated', 'authenticated', $2,
       crypt('pass-test-123', gen_salt('bf')), now(),
       '{"provider":"email"}'::jsonb, '{}'::jsonb, now(), now()
     )`,
    [userId, `m31-${role}-${userId.slice(0, 8)}@test.local`],
  );
  await admin.query(
    `insert into public.profiles (id, role, full_name, email)
     values ($1, $2, $3, $4)
     on conflict (id) do update set role = excluded.role, disabled_at = null`,
    [userId, role, `M3-1 ${role}`, `m31-${role}-${userId.slice(0, 8)}@test.local`],
  );
  return userId;
}

async function cleanupStaff(userId) {
  await admin.query(
    `update public.patients set created_by = null,
       aadhaar_duplicate_override_by = null,
       likely_duplicate_override_by = null
     where created_by = $1
        or aadhaar_duplicate_override_by = $1
        or likely_duplicate_override_by = $1`,
    [userId],
  );
  await admin.query(`delete from public.profiles where id = $1`, [userId]);
  await admin.query(`delete from auth.users where id = $1`, [userId]);
}

describe("EMPIRICAL CHALLENGE M3-1: Capacity, Duplicate & SMS Serialization Stress Tests", { concurrency: 1 }, () => {
  // --------------------------------------------------------------------------
  // #66: HIGH CONCURRENCY CAPACITY SERIALIZATION
  // --------------------------------------------------------------------------
  test("EMPIRICAL #66: 20 concurrent registration workers on seat limit = 5 → exactly 5 succeed, 15 fail, limit ≥ taken invariant holds", async (t) => {
    if (skipIfNoDb(t)) return;
    const staffId = await seedStaff("volunteer");
    const { campId, days } = await seedCampWithDays(1, 5); // seatLimit = 5
    const dayId = days[0].dayId;

    const WORKERS = 20;
    const tasks = Array.from({ length: WORKERS }, (_, i) => async () => {
      const c = newClient();
      await c.connect();
      try {
        await c.query("begin");
        await setAuth(c, staffId);
        try {
          const row = await register(c, {
            requestId: randomUUID(),
            campId,
            dayId,
            fullName: `Capacity Worker ${i + 1}`,
            age: 20 + i,
            phone: `99000${String(10000 + i).slice(1)}`,
          });
          await c.query("commit");
          return { ok: true, row };
        } catch (err) {
          await c.query("rollback");
          return { ok: false, error: String(err.message || err) };
        }
      } finally {
        await c.end();
      }
    });

    const results = await Promise.all(tasks.map((fn) => fn()));
    const successes = results.filter((r) => r.ok);
    const failures = results.filter((r) => !r.ok);

    assert.equal(successes.length, 5, `Expected exactly 5 successes, got ${successes.length}`);
    assert.equal(failures.length, 15, `Expected exactly 15 failures, got ${failures.length}`);

    for (const fail of failures) {
      assert.match(fail.error, /full|seat/i, `Failure message must cite seat limit: ${fail.error}`);
    }

    const { rows: countRows } = await admin.query(
      `select count(*)::int as n from public.patients where camp_day_id = $1`,
      [dayId],
    );
    assert.equal(countRows[0].n, 5, "DB patient count must equal 5");

    const { rows: dayRows } = await admin.query(
      `select seat_limit from public.camp_days where id = $1`,
      [dayId],
    );
    assert.equal(dayRows[0].seat_limit, 5, "Seat limit must remain 5");
    assert.ok(dayRows[0].seat_limit >= countRows[0].n, "seat_limit >= patients count invariant must hold");

    await cleanupCamp(campId);
    await cleanupStaff(staffId);
  });

  test("EMPIRICAL #66: Interleaved concurrent seat limit updates & registrations → seat_limit >= count invariant NEVER broken", async (t) => {
    if (skipIfNoDb(t)) return;
    const adminId = await seedStaff("admin");
    const volunteerId = await seedStaff("volunteer");
    const { campId, days } = await seedCampWithDays(1, 10);
    const dayId = days[0].dayId;
    const dayDate = days[0].dayDate;

    // We start with 10 seats.
    // 10 volunteer workers register patients, while 5 admin workers try to lower capacity to 3, 4, 5, etc.
    const regTasks = Array.from({ length: 10 }, (_, i) => async () => {
      const c = newClient();
      await c.connect();
      try {
        await c.query("begin");
        await setAuth(c, volunteerId);
        try {
          const row = await register(c, {
            requestId: randomUUID(),
            campId,
            dayId,
            fullName: `Interleave Patient ${i + 1}`,
            age: 25 + i,
          });
          await c.query("commit");
          return { type: "reg", ok: true, row };
        } catch (err) {
          await c.query("rollback");
          return { type: "reg", ok: false, error: String(err.message || err) };
        }
      } finally {
        await c.end();
      }
    });

    const editTasks = Array.from({ length: 5 }, (_, i) => async () => {
      await sleep(i * 15);
      const c = newClient();
      await c.connect();
      try {
        await c.query("begin");
        await setAuth(c, adminId);
        try {
          await upsertDay(c, {
            campId,
            dayDate,
            seatLimit: 3 + i, // 3, 4, 5, 6, 7
            dayId,
          });
          await c.query("commit");
          return { type: "edit", ok: true, limit: 3 + i };
        } catch (err) {
          await c.query("rollback");
          return { type: "edit", ok: false, error: String(err.message || err) };
        }
      } finally {
        await c.end();
      }
    });

    await Promise.all([...regTasks.map((fn) => fn()), ...editTasks.map((fn) => fn())]);

    const { rows: countRows } = await admin.query(
      `select count(*)::int as n from public.patients where camp_day_id = $1`,
      [dayId],
    );
    const { rows: dayRows } = await admin.query(
      `select seat_limit from public.camp_days where id = $1`,
      [dayId],
    );

    const count = countRows[0].n;
    const limit = dayRows[0].seat_limit;

    assert.ok(
      limit >= count,
      `INVARIANT VIOLATION! seat_limit=${limit} is less than registered patients=${count}`,
    );

    await cleanupCamp(campId);
    await cleanupStaff(adminId);
    await cleanupStaff(volunteerId);
  });

  // --------------------------------------------------------------------------
  // #67: HIGH CONCURRENCY LIKELY-DUPLICATE SERIALIZATION
  // --------------------------------------------------------------------------
  test("EMPIRICAL #67: 10 concurrent registrations with identical soft key (name+age) across DIFFERENT days → soft lock serializes: 1 insert, 9 LIKELY_DUPLICATE warnings", async (t) => {
    if (skipIfNoDb(t)) return;
    const staffId = await seedStaff("volunteer");
    const { campId, days } = await seedCampWithDays(2, 50); // day1 and day2
    const day1 = days[0].dayId;
    const day2 = days[1].dayId;

    const WORKERS = 10;
    const targetName = "Same Person Multiday";
    const targetAge = 48;

    const tasks = Array.from({ length: WORKERS }, (_, i) => async () => {
      const c = newClient();
      await c.connect();
      try {
        await c.query("begin");
        await setAuth(c, staffId);
        const dayId = i % 2 === 0 ? day1 : day2;
        try {
          const row = await register(c, {
            requestId: randomUUID(),
            campId,
            dayId,
            fullName: targetName,
            age: targetAge,
          });
          await c.query("commit");
          return { ok: true, row };
        } catch (err) {
          await c.query("rollback");
          return { ok: false, error: String(err.message || err) };
        }
      } finally {
        await c.end();
      }
    });

    const results = await Promise.all(tasks.map((fn) => fn()));
    const successes = results.filter((r) => r.ok);
    const warnings = results.filter((r) => !r.ok);

    assert.equal(successes.length, 1, `Expected exactly 1 success, got ${successes.length}`);
    assert.equal(warnings.length, 9, `Expected exactly 9 warnings, got ${warnings.length}`);

    for (const warn of warnings) {
      assert.match(warn.error, /LIKELY_DUPLICATE:reg=/, `Warning must cite LIKELY_DUPLICATE: ${warn.error}`);
    }

    const { rows: countRows } = await admin.query(
      `select count(*)::int as n from public.patients where camp_id = $1`,
      [campId],
    );
    assert.equal(countRows[0].n, 1, "Exactly 1 patient row must exist in DB for the camp");

    await cleanupCamp(campId);
    await cleanupStaff(staffId);
  });

  test("EMPIRICAL #67: Manual staff override (likelyOverride = true) successfully creates second patient and attributes override", async (t) => {
    if (skipIfNoDb(t)) return;
    const staffId = await seedStaff("volunteer");
    const { campId, days } = await seedCampWithDays(2, 50);
    const day1 = days[0].dayId;
    const day2 = days[1].dayId;

    const c = newClient();
    await c.connect();
    try {
      // 1. Initial registration
      await c.query("begin");
      await setAuth(c, staffId);
      const first = await register(c, {
        requestId: randomUUID(),
        campId,
        dayId: day1,
        fullName: "Twin Patient One",
        age: 30,
        phone: "9876543210",
      });
      await c.query("commit");
      assert.ok(first?.id);

      // 2. Second registration without override → rejected with LIKELY_DUPLICATE
      await c.query("begin");
      await setAuth(c, staffId);
      let rejected = null;
      try {
        await register(c, {
          requestId: randomUUID(),
          campId,
          dayId: day2,
          fullName: "Twin Patient One",
          age: 30,
          phone: "9876543210",
        });
        await c.query("commit");
      } catch (err) {
        await c.query("rollback");
        rejected = String(err.message || err);
      }
      assert.match(rejected, /LIKELY_DUPLICATE:reg=/);

      // 3. Third registration WITH override → succeeds
      await c.query("begin");
      await setAuth(c, staffId);
      const second = await register(c, {
        requestId: randomUUID(),
        campId,
        dayId: day2,
        fullName: "Twin Patient One",
        age: 30,
        phone: "9876543210",
        likelyOverride: true,
      });
      await c.query("commit");
      assert.ok(second?.id);
      assert.notEqual(second.id, first.id);

      // Verify DB attribution
      const { rows: attrRows } = await admin.query(
        `select likely_duplicate_override_by, likely_duplicate_override_at
         from public.patients where id = $1`,
        [second.id],
      );
      assert.equal(attrRows[0].likely_duplicate_override_by, staffId);
      assert.ok(attrRows[0].likely_duplicate_override_at);
    } finally {
      await c.end();
      await cleanupCamp(campId);
      await cleanupStaff(staffId);
    }
  });

  // --------------------------------------------------------------------------
  // #65: SMS DELIVERY LEDGER & CONCURRENT CLAIMING
  // --------------------------------------------------------------------------
  test("EMPIRICAL #65: 10 concurrent workers claiming same pending SMS delivery → exactly 1 worker wins claim", async (t) => {
    if (skipIfNoDb(t)) return;
    const { campId } = await seedCampWithDays(1, 50);
    const patientId = randomUUID();

    await admin.query(
      `insert into public.patients (id, camp_id, full_name, queue_status, phone)
       values ($1, $2, 'SMS Race Patient', 'registered', '9888877777')`,
      [patientId, campId],
    );
    await admin.query(
      `insert into public.sms_deliveries (patient_id, kind, state, phone_last4)
       values ($1, 'reminder', 'pending', '7777')`,
      [patientId],
    );

    const WORKERS = 10;
    const tasks = Array.from({ length: WORKERS }, () => async () => {
      const c = newClient();
      await c.connect();
      try {
        await c.query("begin");
        await c.query(`select set_config('request.jwt.claim.role', 'service_role', true)`);
        const { rows } = await c.query(
          `select delivery_id, claim_token
           from public.claim_sms_delivery($1, 'reminder', '7777', 120)`,
          [patientId],
        );
        await c.query("commit");
        return rows[0] || null;
      } catch (err) {
        await c.query("rollback");
        return { error: String(err.message || err) };
      } finally {
        await c.end();
      }
    });

    const results = await Promise.all(tasks.map((fn) => fn()));
    const winners = results.filter((r) => r && r.delivery_id);
    const losers = results.filter((r) => !r || !r.delivery_id);

    assert.equal(winners.length, 1, `Expected exactly 1 claim winner, got ${winners.length}`);
    assert.equal(losers.length, 9, `Expected exactly 9 losers, got ${losers.length}`);

    const { rows: deliveryState } = await admin.query(
      `select state, attempt_count from public.sms_deliveries where patient_id = $1`,
      [patientId],
    );
    assert.equal(deliveryState[0].state, "sending");
    assert.equal(deliveryState[0].attempt_count, 1);

    await cleanupCamp(campId);
  });

  // --------------------------------------------------------------------------
  // #68: SCHEMA DRIFT & MIGRATION READINESS
  // --------------------------------------------------------------------------
  test("EMPIRICAL #68: Applied migration head matches contract & catalog probe satisfies all checks", async (t) => {
    if (skipIfNoDb(t)) return;

    // 1. Repo migration head vs contract
    const migDir = path.join(root, "supabase", "migrations");
    const files = fs.readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
    const headFile = files[files.length - 1];
    const head = headFile.slice(0, 14);

    assert.equal(
      head,
      EXPECTED_MIGRATION_HEAD,
      `EXPECTED_MIGRATION_HEAD constant (${EXPECTED_MIGRATION_HEAD}) must match latest migration file (${head})`,
    );

    // 2. DB applied migration head
    const { rows: headRows } = await admin.query(
      `select public.latest_applied_migration() as version`,
    );
    assert.equal(headRows[0].version, EXPECTED_MIGRATION_HEAD);

    // 3. Catalog probe evaluation
    const { rows: probeRows } = await admin.query(
      `select public.readiness_catalog_probe() as facts`,
    );
    const facts = probeRows[0].facts;
    const evald = evaluateCatalogFacts(facts);

    assert.equal(evald.schema_contract.ok, true, `Schema contract failed: ${evald.schema_contract.detail}`);
    assert.equal(evald.rpc_grants.ok, true, `RPC grants failed: ${evald.rpc_grants.detail}`);
    assert.equal(evald.patients_realtime_absent.ok, true, `Patients realtime check failed: ${evald.patients_realtime_absent.detail}`);
    assert.equal(evald.sms_ledger.ok, true, `SMS ledger check failed: ${evald.sms_ledger.detail}`);
  });
});

