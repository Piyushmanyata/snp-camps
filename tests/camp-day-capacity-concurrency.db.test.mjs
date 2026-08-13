/**
 * #66 — Serialize camp-day capacity edits with registrations.
 * Requires local Supabase Postgres (default 127.0.0.1:54322).
 *
 * Proof uses two real pg.Client connections and barriers — not sequential
 * promises alone. Final DB invariants asserted after both txns settle.
 *
 * Schedules:
 *  A) Reg holds day lock while admin lowers limit → edit rejects (or final
 *     limit ≥ final patient count).
 *  B) Edit locks first, reg follows → capacity preserved (reg full).
 *  C) Two concurrent regs at final seat → at most one success.
 *  D) Edit above/equal succeeds; below returns SEAT_LIMIT_BELOW_ASSIGNED.
 *  E) Smoke: wrong-camp/day, permission, not-found.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

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
             'public.register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean,boolean,text,text,date,text)'
           ) is not null as ok`,
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
      "[camp-day-capacity-concurrency.db] local Postgres unavailable — DB tests skipped",
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

/**
 * @param {pg.Client} c
 * @param {string} userId
 * @param {'authenticated'|'service_role'} [role]
 */
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

/**
 * @param {pg.Client} c
 * @param {object} args
 */
async function register(c, args) {
  const {
    requestId,
    campId,
    dayId,
    fullName,
    age = 40,
    phone = null,
  } = args;
  const { rows } = await c.query(
    `select id, reg_no, full_name, queue_status
     from public.register_patient_idempotent(
       $1::uuid, $2::uuid, $3::text,
       'M', $4::integer, 'Addr', $5::text, null, null,
       null, null, $6::uuid, false, false, false, 'self_declared', null, null, null)`,
    [requestId, campId, fullName, age, phone, dayId],
  );
  return rows[0];
}

/**
 * @param {pg.Client} c
 * @param {object} args
 */
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

async function seedCampDay({ seatLimit = 5, dayDate = "2099-11-01" } = {}) {
  const campId = randomUUID();
  const dayId = randomUUID();
  await admin.query("begin");
  try {
    await admin.query("select pg_advisory_xact_lock(918273666)");
    await admin.query(
      `update public.camps set is_active = false where is_active = true`,
    );
    await admin.query(
      `insert into public.camps (id, name, is_active, venue)
       values ($1, $2, true, 'cap-conc')`,
      [campId, `Cap-conc camp ${campId.slice(0, 8)}`],
    );
    await admin.query(
      `insert into public.camp_days (id, camp_id, day_date, seat_limit)
       values ($1, $2, $3::date, $4)`,
      [dayId, campId, dayDate, seatLimit],
    );
    await admin.query("commit");
  } catch (err) {
    await admin.query("rollback");
    throw err;
  }
  return { campId, dayId, dayDate };
}

async function cleanupCamp(campId) {
  await admin.query(`delete from public.patients where camp_id = $1`, [campId]);
  await admin.query(`delete from public.camp_days where camp_id = $1`, [campId]);
  await admin.query(`delete from public.camps where id = $1`, [campId]);
}

/**
 * @param {'admin'|'volunteer'} role
 */
async function seedStaff(role = "admin") {
  const userId = randomUUID();
  await admin.query(
    `insert into auth.users (
       id, instance_id, aud, role, email,
       encrypted_password, email_confirmed_at,
       raw_app_meta_data, raw_user_meta_data,
       created_at, updated_at
     ) values (
       $1,
       '00000000-0000-0000-0000-000000000000',
       'authenticated', 'authenticated',
       $2,
       crypt('test-pass-not-used', gen_salt('bf')),
       now(),
       '{"provider":"email","providers":["email"]}'::jsonb,
       '{}'::jsonb,
       now(), now()
     )`,
    [userId, `${role}-cap-${userId.slice(0, 8)}@test.local`],
  );
  await admin.query(
    `insert into public.profiles (id, role, full_name, email)
     values ($1, $2, $3, $4)
     on conflict (id) do update set role = excluded.role, disabled_at = null`,
    [
      userId,
      role,
      `Cap ${role}`,
      `${role}-cap-${userId.slice(0, 8)}@test.local`,
    ],
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

async function patientCount(dayId) {
  const { rows } = await admin.query(
    `select count(*)::int as n from public.patients where camp_day_id = $1`,
    [dayId],
  );
  return rows[0].n;
}

async function seatLimit(dayId) {
  const { rows } = await admin.query(
    `select seat_limit from public.camp_days where id = $1`,
    [dayId],
  );
  return rows[0]?.seat_limit;
}

/**
 * Seed N committed patients on a day (bypass RPC for speed).
 * @param {string} campId
 * @param {string} dayId
 * @param {number} n
 */
async function seedPatients(campId, dayId, n) {
  for (let i = 0; i < n; i++) {
    await admin.query(
      `insert into public.patients (camp_id, camp_day_id, full_name, queue_status)
       values ($1, $2, $3, 'registered')`,
      [campId, dayId, `Seed Patient ${i + 1}`],
    );
  }
}

describe("camp-day capacity concurrency", { concurrency: 1 }, () => {
// ---------------------------------------------------------------------------
// A) Registration holds day lock; admin lowers limit
// ---------------------------------------------------------------------------
test("reg holds day lock while admin lowers limit → edit rejects; limit ≥ count", { concurrency: false }, async (t) => {
  console.log('[TEST LOG] START test A', new Date().toISOString());
  if (skipIfNoDb(t)) return;

  const adminId = await seedStaff("admin");
  const staffId = await seedStaff("volunteer");
  // seat_limit=5 with 4 committed → reg takes 5th and holds; admin tries limit=4
  const { campId, dayId, dayDate } = await seedCampDay({ seatLimit: 5 });
  await seedPatients(campId, dayId, 4);

  const cReg = newClient();
  const cEdit = newClient();
  await cReg.connect();
  await cEdit.connect();

  try {
    await cReg.query("begin");
    await setAuth(cReg, staffId);
    const regRow = await register(cReg, {
      requestId: randomUUID(),
      campId,
      dayId,
      fullName: "Race Register Hold",
      age: 33,
    });
    assert.ok(regRow?.reg_no, "registration must insert under held txn");

    let editSettled = false;
    const editPromise = (async () => {
      await cEdit.query("begin");
      await setAuth(cEdit, adminId);
      try {
        const row = await upsertDay(cEdit, {
          campId,
          dayDate,
          seatLimit: 4,
          dayId,
        });
        editSettled = true;
        await cEdit.query("commit");
        return { ok: true, row };
      } catch (err) {
        editSettled = true;
        await cEdit.query("rollback");
        return { ok: false, message: String(err.message || err) };
      }
    })();

    // Edit must block on camp_days FOR UPDATE while reg txn is open.
    await sleep(200);
    assert.equal(
      editSettled,
      false,
      "admin upsert must wait on day-row lock held by open registration",
    );

    await cReg.query("commit");
    const edit = await editPromise;

    assert.equal(edit.ok, false, `expected capacity reject, got ${JSON.stringify(edit)}`);
    assert.match(
      edit.message,
      /SEAT_LIMIT_BELOW_ASSIGNED:taken=5|Cannot set seats below taken/i,
      edit.message,
    );

    const taken = await patientCount(dayId);
    const limit = await seatLimit(dayId);
    assert.equal(taken, 5);
    assert.ok(
      limit >= taken,
      `invariant broken: seat_limit=${limit} < patients=${taken}`,
    );
    assert.equal(limit, 5, "rejected edit must leave original seat_limit");
  } finally {
    try {
      await cReg.query("rollback");
    } catch {
      /* ignore */
    }
    try {
      await cEdit.query("rollback");
    } catch {
      /* ignore */
    }
    await cReg.end();
    await cEdit.end();
    await cleanupCamp(campId);
    await cleanupStaff(adminId);
    await cleanupStaff(staffId);
  }
  console.log('[TEST LOG] END test A', new Date().toISOString());
});

// ---------------------------------------------------------------------------
// B) Edit locks first; registration follows
// ---------------------------------------------------------------------------
test("edit locks first then reg follows → capacity preserved (reg full)", { concurrency: false }, async (t) => {
  console.log('[TEST LOG] START test B', new Date().toISOString());
  if (skipIfNoDb(t)) return;

  const adminId = await seedStaff("admin");
  const staffId = await seedStaff("volunteer");
  // 4 patients, limit 5 → admin sets limit=4 while holding lock; reg wants 5th
  const { campId, dayId, dayDate } = await seedCampDay({ seatLimit: 5 });
  await seedPatients(campId, dayId, 4);

  const cEdit = newClient();
  const cReg = newClient();
  await cEdit.connect();
  await cReg.connect();

  try {
    await cEdit.query("begin");
    await setAuth(cEdit, adminId);
    const edited = await upsertDay(cEdit, {
      campId,
      dayDate,
      seatLimit: 4,
      dayId,
    });
    assert.equal(edited.seat_limit, 4);

    let regSettled = false;
    const regPromise = (async () => {
      await cReg.query("begin");
      await setAuth(cReg, staffId);
      try {
        const row = await register(cReg, {
          requestId: randomUUID(),
          campId,
          dayId,
          fullName: "Late Register After Cap",
          age: 44,
        });
        regSettled = true;
        await cReg.query("commit");
        return { ok: true, row };
      } catch (err) {
        regSettled = true;
        await cReg.query("rollback");
        return { ok: false, message: String(err.message || err) };
      }
    })();

    await sleep(200);
    assert.equal(
      regSettled,
      false,
      "registration must wait on day-row lock held by open admin edit",
    );

    await cEdit.query("commit");
    const reg = await regPromise;

    assert.equal(reg.ok, false, `expected day-full, got ${JSON.stringify(reg)}`);
    assert.match(reg.message, /full|seat/i, reg.message);

    const taken = await patientCount(dayId);
    const limit = await seatLimit(dayId);
    assert.equal(taken, 4);
    assert.equal(limit, 4);
    assert.ok(limit >= taken);
  } finally {
    try {
      await cEdit.query("rollback");
    } catch {
      /* ignore */
    }
    try {
      await cReg.query("rollback");
    } catch {
      /* ignore */
    }
    await cEdit.end();
    await cReg.end();
    await cleanupCamp(campId);
    await cleanupStaff(adminId);
    await cleanupStaff(staffId);
  }
  console.log('[TEST LOG] END test B', new Date().toISOString());
});

// ---------------------------------------------------------------------------
// C) Two concurrent registrations at the final seat
// ---------------------------------------------------------------------------
test("two concurrent regs at final seat → at most one success", { concurrency: false }, async (t) => {
  console.log('[TEST LOG] START test C', new Date().toISOString());
  if (skipIfNoDb(t)) return;

  const staffId = await seedStaff("volunteer");
  const { campId, dayId } = await seedCampDay({ seatLimit: 1 });
  // empty day, limit 1

  const c1 = newClient();
  const c2 = newClient();
  await c1.connect();
  await c2.connect();

  try {
    const run = async (c, name) => {
      await c.query("begin");
      await setAuth(c, staffId);
      try {
        const row = await register(c, {
          requestId: randomUUID(),
          campId,
          dayId,
          fullName: name,
          age: 50 + Math.floor(Math.random() * 20),
        });
        await c.query("commit");
        return { ok: true, row };
      } catch (err) {
        await c.query("rollback");
        return { ok: false, message: String(err.message || err) };
      }
    };

    const [a, b] = await Promise.all([
      run(c1, "Concurrent Seat A"),
      run(c2, "Concurrent Seat B"),
    ]);
    const successes = [a, b].filter((r) => r.ok);
    const failures = [a, b].filter((r) => !r.ok);

    assert.equal(
      successes.length,
      1,
      `expected exactly 1 success, got ${JSON.stringify([a, b])}`,
    );
    assert.equal(failures.length, 1);
    assert.match(failures[0].message, /full|seat/i, failures[0].message);

    const taken = await patientCount(dayId);
    const limit = await seatLimit(dayId);
    assert.equal(taken, 1);
    assert.ok(limit >= taken);
  } finally {
    try {
      await c1.query("rollback");
    } catch {
      /* ignore */
    }
    try {
      await c2.query("rollback");
    } catch {
      /* ignore */
    }
    await c1.end();
    await c2.end();
    await cleanupCamp(campId);
    await cleanupStaff(staffId);
  }
  console.log('[TEST LOG] END test C', new Date().toISOString());
});

// ---------------------------------------------------------------------------
// D) Edit above/equal succeeds; below returns stable code
// ---------------------------------------------------------------------------
test("edit equal/above count succeeds; below returns SEAT_LIMIT_BELOW_ASSIGNED", { concurrency: false }, async (t) => {
  console.log('[TEST LOG] START test D', new Date().toISOString());
  if (skipIfNoDb(t)) return;

  const adminId = await seedStaff("admin");
  const { campId, dayId, dayDate } = await seedCampDay({ seatLimit: 10 });
  await seedPatients(campId, dayId, 3);

  const c = newClient();
  await c.connect();
  try {
    await c.query("begin");
    await setAuth(c, adminId);
    const eq = await upsertDay(c, {
      campId,
      dayDate,
      seatLimit: 3,
      dayId,
    });
    await c.query("commit");
    assert.equal(eq.seat_limit, 3);

    await c.query("begin");
    await setAuth(c, adminId);
    const above = await upsertDay(c, {
      campId,
      dayDate,
      seatLimit: 7,
      dayId,
    });
    await c.query("commit");
    assert.equal(above.seat_limit, 7);

    await c.query("begin");
    await setAuth(c, adminId);
    let belowMsg = null;
    try {
      await upsertDay(c, {
        campId,
        dayDate,
        seatLimit: 2,
        dayId,
      });
      await c.query("commit");
    } catch (err) {
      await c.query("rollback");
      belowMsg = String(err.message || err);
    }
    assert.match(belowMsg || "", /SEAT_LIMIT_BELOW_ASSIGNED:taken=3/);
    assert.equal(await seatLimit(dayId), 7);
    assert.equal(await patientCount(dayId), 3);
  } finally {
    try {
      await c.query("rollback");
    } catch {
      /* ignore */
    }
    await c.end();
    await cleanupCamp(campId);
    await cleanupStaff(adminId);
  }
  console.log('[TEST LOG] END test D', new Date().toISOString());
});

// ---------------------------------------------------------------------------
// E) Smoke: wrong camp/day, permission, not-found
// ---------------------------------------------------------------------------
test("smoke: not-found, wrong camp, non-admin permission", { concurrency: false }, async (t) => {
  console.log('[TEST LOG] START test E', new Date().toISOString());
  if (skipIfNoDb(t)) return;

  const adminId = await seedStaff("admin");
  const volunteerId = await seedStaff("volunteer");
  const { campId, dayId, dayDate } = await seedCampDay({ seatLimit: 8 });
  const otherCamp = randomUUID();
  await admin.query(
    `insert into public.camps (id, name, is_active, venue)
     values ($1, $2, false, 'other')`,
    [otherCamp, `Other ${otherCamp.slice(0, 8)}`],
  );

  const c = newClient();
  await c.connect();
  try {
    // not found
    await c.query("begin");
    await setAuth(c, adminId);
    let notFound = null;
    try {
      await upsertDay(c, {
        campId,
        dayDate,
        seatLimit: 8,
        dayId: randomUUID(),
      });
      await c.query("commit");
    } catch (err) {
      await c.query("rollback");
      notFound = String(err.message || err);
    }
    assert.match(notFound || "", /Day not found/i);

    // wrong camp ownership for existing day id
    await c.query("begin");
    await setAuth(c, adminId);
    let wrongCamp = null;
    try {
      await upsertDay(c, {
        campId: otherCamp,
        dayDate,
        seatLimit: 8,
        dayId,
      });
      await c.query("commit");
    } catch (err) {
      await c.query("rollback");
      wrongCamp = String(err.message || err);
    }
    assert.match(wrongCamp || "", /Day not found/i);

    // non-admin
    await c.query("begin");
    await setAuth(c, volunteerId);
    let denied = null;
    try {
      await upsertDay(c, {
        campId,
        dayDate,
        seatLimit: 9,
        dayId,
      });
      await c.query("commit");
    } catch (err) {
      await c.query("rollback");
      denied = String(err.message || err);
    }
    assert.match(denied || "", /admin only/i);

    // original limit unchanged
    assert.equal(await seatLimit(dayId), 8);
  } finally {
    try {
      await c.query("rollback");
    } catch {
      /* ignore */
    }
    await c.end();
    await cleanupCamp(campId);
    await admin.query(`delete from public.camps where id = $1`, [otherCamp]);
    await cleanupStaff(adminId);
    await cleanupStaff(volunteerId);
  }
  console.log('[TEST LOG] END test E', new Date().toISOString());
});

// ---------------------------------------------------------------------------
// Optional stress: repeated reverse interleavings — no deadlock
// ---------------------------------------------------------------------------
test("stress: repeated edit/reg interleavings complete without deadlock", { concurrency: false }, async (t) => {
  console.log('[TEST LOG] START test stress', new Date().toISOString());
  if (skipIfNoDb(t)) return;

  const adminId = await seedStaff("admin");
  const staffId = await seedStaff("volunteer");
  const { campId, dayId, dayDate } = await seedCampDay({ seatLimit: 3 });
  await seedPatients(campId, dayId, 2);

  const rounds = 6;
  for (let i = 0; i < rounds; i++) {
    // Reset capacity to 3 with exactly 2 patients (delete extras from prior reg)
    await admin.query(
      `delete from public.patients
       where camp_day_id = $1
         and full_name like 'Stress Reg%'`,
      [dayId],
    );
    await admin.query(
      `update public.camps set is_active = false where is_active = true and id != $1`,
      [campId],
    );
    await admin.query(
      `update public.camps set is_active = true where id = $1`,
      [campId],
    );
    await admin.query(
      `update public.camp_days set seat_limit = 3 where id = $1`,
      [dayId],
    );

    const cEdit = newClient();
    const cReg = newClient();
    await cEdit.connect();
    await cReg.connect();
    try {
      const editFirst = i % 2 === 0;

      if (editFirst) {
        await cEdit.query("begin");
        await setAuth(cEdit, adminId);
        await upsertDay(cEdit, {
          campId,
          dayDate,
          seatLimit: 2,
          dayId,
        });

        const regP = (async () => {
          await cReg.query("begin");
          await setAuth(cReg, staffId);
          try {
            await register(cReg, {
              requestId: randomUUID(),
              campId,
              dayId,
              fullName: `Stress Reg ${i}`,
              age: 30 + i,
            });
            await cReg.query("commit");
            return true;
          } catch {
            await cReg.query("rollback");
            return false;
          }
        })();

        await sleep(30);
        await cEdit.query("commit");
        await regP;
      } else {
        await cReg.query("begin");
        await setAuth(cReg, staffId);
        await register(cReg, {
          requestId: randomUUID(),
          campId,
          dayId,
          fullName: `Stress Reg ${i}`,
          age: 30 + i,
        });

        const editP = (async () => {
          await cEdit.query("begin");
          await setAuth(cEdit, adminId);
          try {
            await upsertDay(cEdit, {
              campId,
              dayDate,
              seatLimit: 2,
              dayId,
            });
            await cEdit.query("commit");
            return true;
          } catch {
            await cEdit.query("rollback");
            return false;
          }
        })();

        await sleep(30);
        await cReg.query("commit");
        await editP;
      }

      const taken = await patientCount(dayId);
      const limit = await seatLimit(dayId);
      assert.ok(
        limit >= taken,
        `round ${i}: seat_limit=${limit} < patients=${taken}`,
      );
    } finally {
      try {
        await cEdit.query("rollback");
      } catch {
        /* ignore */
      }
      try {
        await cReg.query("rollback");
      } catch {
        /* ignore */
      }
      await cEdit.end();
      await cReg.end();
    }
  }

  await cleanupCamp(campId);
  await cleanupStaff(adminId);
  await cleanupStaff(staffId);
});
});

