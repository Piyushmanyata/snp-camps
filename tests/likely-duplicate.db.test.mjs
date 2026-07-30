/**
 * Soft-duplicate warning at desk registration (#48).
 * Requires local Supabase Postgres (default 127.0.0.1:54322).
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/** @type {pg.Client | null} */
let client = null;
let dbAvailable = false;

async function connect() {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await c.connect();
    const { rows } = await c.query(
      `select to_regprocedure(
         'public.register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean)'
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
  client = await connect();
  dbAvailable = Boolean(client);
  if (!dbAvailable) {
    console.warn(
      "[likely-duplicate.db] local Postgres unavailable or migration not applied — DB tests skipped",
    );
  }
});

test.after(async () => {
  if (client) await client.end();
});

function skipIfNoDb(t) {
  if (!dbAvailable) {
    t.skip("local Postgres not available");
    return true;
  }
  return false;
}

async function seedCampWithDay(dayDate = "2099-09-01") {
  const campId = randomUUID();
  const dayId = randomUUID();
  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock(918273646)");
    await client.query(
      `update public.camps set is_active = false where is_active = true`,
    );
    await client.query(
      `insert into public.camps (id, name, is_active, venue)
       values ($1, $2, true, 'likely-dup-test')`,
      [campId, `Likely dup camp ${campId.slice(0, 8)}`],
    );
    await client.query(
      `insert into public.camp_days (id, camp_id, day_date, seat_limit)
       values ($1, $2, $3::date, 50)`,
      [dayId, campId, dayDate],
    );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
  return { campId, dayId };
}

async function cleanupCamp(campId) {
  await client.query(`delete from public.patients where camp_id = $1`, [
    campId,
  ]);
  await client.query(`delete from public.camp_days where camp_id = $1`, [
    campId,
  ]);
  await client.query(`delete from public.camps where id = $1`, [campId]);
}

async function seedStaff() {
  const userId = randomUUID();
  await client.query(
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
    [userId, `staff-${userId.slice(0, 8)}@test.local`],
  );
  await client.query(
    `insert into public.profiles (id, role, full_name, email)
     values ($1, 'volunteer', 'Likely Dup Staff', $2)
     on conflict (id) do update set role = excluded.role, disabled_at = null`,
    [userId, `staff-${userId.slice(0, 8)}@test.local`],
  );
  return userId;
}

async function cleanupStaff(userId) {
  await client.query(
    `update public.patients set created_by = null,
       aadhaar_duplicate_override_by = null,
       likely_duplicate_override_by = null
     where created_by = $1
        or aadhaar_duplicate_override_by = $1
        or likely_duplicate_override_by = $1`,
    [userId],
  );
  await client.query(`delete from public.profiles where id = $1`, [userId]);
  await client.query(`delete from auth.users where id = $1`, [userId]);
}

/**
 * @param {string} staffId
 * @param {object} args
 */
async function callRegister(staffId, args) {
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
  await client.query("begin");
  try {
    await client.query(
      `select set_config('request.jwt.claim.role', 'authenticated', true)`,
    );
    await client.query(
      `select set_config('request.jwt.claim.sub', $1, true)`,
      [staffId],
    );
    const { rows } = await client.query(
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
    await client.query("commit");
    return { ok: true, row: rows[0] };
  } catch (err) {
    await client.query("rollback");
    return { ok: false, message: String(err.message || err) };
  }
}

test("name + age match in same camp raises LIKELY_DUPLICATE with reg no", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaff();
  const { campId, dayId } = await seedCampWithDay();
  try {
    const first = await callRegister(staffId, {
      requestId: randomUUID(),
      campId,
      dayId,
      fullName: "Ram Kumar",
      age: 55,
    });
    assert.equal(first.ok, true, first.message);

    const second = await callRegister(staffId, {
      requestId: randomUUID(),
      campId,
      dayId,
      fullName: "  RAM   kumar ",
      age: 55,
    });
    assert.equal(second.ok, false);
    assert.match(second.message, /LIKELY_DUPLICATE:reg=/);
    assert.match(second.message, new RegExp(String(first.row.reg_no)));
  } finally {
    await cleanupCamp(campId);
    await cleanupStaff(staffId);
  }
});

test("shared household phone does not create a duplicate warning", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaff();
  const { campId, dayId } = await seedCampWithDay();
  try {
    const first = await callRegister(staffId, {
      requestId: randomUUID(),
      campId,
      dayId,
      fullName: "Phone One",
      age: 30,
      phone: "9876543210",
    });
    assert.equal(first.ok, true, first.message);

    const second = await callRegister(staffId, {
      requestId: randomUUID(),
      campId,
      dayId,
      fullName: "Different Name",
      age: 99,
      phone: "98765 43210",
    });
    assert.equal(second.ok, true, second.message);
    assert.notEqual(second.row.id, first.row.id);
  } finally {
    await cleanupCamp(campId);
    await cleanupStaff(staffId);
  }
});

test("same name+age in a different camp does not warn", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaff();
  const campA = await seedCampWithDay("2099-09-02");
  try {
    const first = await callRegister(staffId, {
      requestId: randomUUID(),
      campId: campA.campId,
      dayId: campA.dayId,
      fullName: "Cross Camp",
      age: 44,
    });
    assert.equal(first.ok, true, first.message);

    // Deactivate A, create B as the sole active camp.
    await client.query(
      `update public.camps set is_active = false where id = $1`,
      [campA.campId],
    );
    const campB = await seedCampWithDay("2099-09-03");
    try {
      const second = await callRegister(staffId, {
        requestId: randomUUID(),
        campId: campB.campId,
        dayId: campB.dayId,
        fullName: "Cross Camp",
        age: 44,
      });
      assert.equal(second.ok, true, second.message);
      assert.notEqual(second.row.id, first.row.id);
    } finally {
      await cleanupCamp(campB.campId);
    }
  } finally {
    await cleanupCamp(campA.campId);
    await cleanupStaff(staffId);
  }
});

test("likely override inserts second row and records who and when; not sticky", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaff();
  const { campId, dayId } = await seedCampWithDay();
  try {
    const first = await callRegister(staffId, {
      requestId: randomUUID(),
      campId,
      dayId,
      fullName: "Sita Devi",
      age: 60,
    });
    assert.equal(first.ok, true, first.message);

    const second = await callRegister(staffId, {
      requestId: randomUUID(),
      campId,
      dayId,
      fullName: "Sita Devi",
      age: 60,
      likelyOverride: true,
    });
    assert.equal(second.ok, true, second.message);
    assert.notEqual(second.row.id, first.row.id);

    const { rows } = await client.query(
      `select reg_no, likely_duplicate_override_by, likely_duplicate_override_at
       from public.patients where id = $1`,
      [second.row.id],
    );
    assert.equal(rows[0].likely_duplicate_override_by, staffId);
    assert.ok(rows[0].likely_duplicate_override_at);

    // Next registration without override must warn again (not sticky).
    const third = await callRegister(staffId, {
      requestId: randomUUID(),
      campId,
      dayId,
      fullName: "Sita Devi",
      age: 60,
      likelyOverride: false,
    });
    assert.equal(third.ok, false);
    assert.match(third.message, /LIKELY_DUPLICATE:reg=/);
  } finally {
    await cleanupCamp(campId);
    await cleanupStaff(staffId);
  }
});

test("check-in of soft-match reg creates no new patient", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaff();
  const { campId, dayId } = await seedCampWithDay();
  try {
    const first = await callRegister(staffId, {
      requestId: randomUUID(),
      campId,
      dayId,
      fullName: "Check In Path",
      age: 33,
    });
    assert.equal(first.ok, true, first.message);
    assert.equal(first.row.queue_status, "registered");

    const before = await client.query(
      `select count(*)::int as n from public.patients where camp_id = $1`,
      [campId],
    );

    await client.query("begin");
    await client.query(
      `select set_config('request.jwt.claim.role', 'authenticated', true)`,
    );
    await client.query(
      `select set_config('request.jwt.claim.sub', $1, true)`,
      [staffId],
    );
    // Mirror check-in.db: full claims JSON so auth.uid() resolves.
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ role: "authenticated", sub: staffId }),
    ]);
    const { rows: checkRows } = await client.query(
      `select * from public.check_in_patient(null, $1)`,
      [first.row.reg_no],
    );
    await client.query("commit");

    assert.equal(checkRows[0].queue_status, "waiting");
    assert.equal(checkRows[0].already_waiting, false);

    const after = await client.query(
      `select count(*)::int as n from public.patients where camp_id = $1`,
      [campId],
    );
    assert.equal(after.rows[0].n, before.rows[0].n);
  } finally {
    await cleanupCamp(campId);
    await cleanupStaff(staffId);
  }
});

test("soft match query is indexed (name+age plan uses index)", async (t) => {
  if (skipIfNoDb(t)) return;
  const { rows } = await client.query(
    `select indexname from pg_indexes
     where schemaname = 'public'
       and indexname in (
         'patients_camp_name_age_idx',
         'patients_camp_phone_normalized_idx'
       )
     order by indexname`,
  );
  assert.equal(rows.length, 2, "both soft-match indexes must exist");
});
