/**
 * Real-database coverage for Aadhaar last-4 + name uniqueness (#21 / D10).
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
         'public.register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean)'
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
      "[aadhaar-duplicate.db] local Postgres unavailable or migration not applied — DB tests skipped",
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

async function seedCampWithDay() {
  const campId = randomUUID();
  const dayId = randomUUID();
  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock(918273645)");
    await client.query(
      `update public.camps set is_active = false where is_active = true`,
    );
    await client.query(
      `insert into public.camps (id, name, is_active, venue)
       values ($1, $2, true, 'aadhaar-test')`,
      [campId, `Aadhaar camp ${campId.slice(0, 8)}`],
    );
    await client.query(
      `insert into public.camp_days (id, camp_id, day_date, seat_limit)
       values ($1, $2, '2099-08-01'::date, 50)`,
      [dayId, campId],
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
     values ($1, 'volunteer', 'Aadhaar Test Staff', $2)
     on conflict (id) do update set role = excluded.role, disabled_at = null`,
    [userId, `staff-${userId.slice(0, 8)}@test.local`],
  );
  return userId;
}

async function cleanupStaff(userId) {
  await client.query(
    `update public.patients set created_by = null,
       aadhaar_duplicate_override_by = null
     where created_by = $1 or aadhaar_duplicate_override_by = $1`,
    [userId],
  );
  await client.query(`delete from public.profiles where id = $1`, [userId]);
  await client.query(`delete from auth.users where id = $1`, [userId]);
}

async function callRegister(staffId, args) {
  const {
    requestId,
    campId,
    dayId,
    fullName,
    aadhaarLast4,
    override = false,
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
      `select id, reg_no, full_name
       from public.register_patient_idempotent(
         $1::uuid, $2::uuid, $3::text,
         'M', 40, 'Addr', null, null, $4::text,
         null, null, $5::uuid, $6::boolean
       )`,
      [requestId, campId, fullName, aadhaarLast4, dayId, override],
    );
    await client.query("commit");
    return { ok: true, row: rows[0] };
  } catch (err) {
    await client.query("rollback");
    return { ok: false, message: String(err.message || err) };
  }
}

test("duplicate Aadhaar last-4 + name raises mapped message with reg no", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaff();
  const { campId, dayId } = await seedCampWithDay();
  try {
    const first = await callRegister(staffId, {
      requestId: randomUUID(),
      campId,
      dayId,
      fullName: "Ram Singh",
      aadhaarLast4: "4321",
    });
    assert.equal(first.ok, true, first.message);
    assert.ok(first.row.reg_no);

    const second = await callRegister(staffId, {
      requestId: randomUUID(),
      campId,
      dayId,
      fullName: "  RAM SINGH  ", // normalised match
      aadhaarLast4: "4321",
    });
    assert.equal(second.ok, false);
    assert.match(second.message, /AADHAAR_DUPLICATE:reg=/);
    assert.match(second.message, new RegExp(String(first.row.reg_no)));
    // Never leak raw unique_violation noise as the only signal.
    assert.doesNotMatch(second.message, /patients_camp_aadhaar_name_uidx/i);
  } finally {
    await cleanupCamp(campId);
    await cleanupStaff(staffId);
  }
});

test("staff override inserts second row and records who and when", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaff();
  const { campId, dayId } = await seedCampWithDay();
  try {
    const first = await callRegister(staffId, {
      requestId: randomUUID(),
      campId,
      dayId,
      fullName: "Sita Devi",
      aadhaarLast4: "9988",
    });
    assert.equal(first.ok, true, first.message);

    const second = await callRegister(staffId, {
      requestId: randomUUID(),
      campId,
      dayId,
      fullName: "Sita Devi",
      aadhaarLast4: "9988",
      override: true,
    });
    assert.equal(second.ok, true, second.message);
    assert.notEqual(second.row.id, first.row.id);

    const { rows } = await client.query(
      `select reg_no, aadhaar_duplicate_override_by, aadhaar_duplicate_override_at
       from public.patients where id = $1`,
      [second.row.id],
    );
    assert.equal(rows[0].aadhaar_duplicate_override_by, staffId);
    assert.ok(rows[0].aadhaar_duplicate_override_at);
  } finally {
    await cleanupCamp(campId);
    await cleanupStaff(staffId);
  }
});

test("service_role cannot pass aadhaar override", async (t) => {
  if (skipIfNoDb(t)) return;
  const { campId, dayId } = await seedCampWithDay();
  try {
    await client.query("begin");
    await client.query(
      `select set_config('request.jwt.claim.role', 'service_role', true)`,
    );
    await client.query(
      `select id from public.register_patient_idempotent(
         $1::uuid, $2::uuid, 'First Public',
         null, 20, null, '9111111111', null, '1111',
         null, null, $3::uuid, false
       )`,
      [randomUUID(), campId, dayId],
    );
    await client.query("commit");

    await client.query("begin");
    await client.query(
      `select set_config('request.jwt.claim.role', 'service_role', true)`,
    );
    let message = "";
    try {
      await client.query(
        `select id from public.register_patient_idempotent(
           $1::uuid, $2::uuid, 'First Public',
           null, 20, null, '9222222222', null, '1111',
           null, null, $3::uuid, true
         )`,
        [randomUUID(), campId, dayId],
      );
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      message = String(err.message || err);
    }
    assert.match(message, /override requires staff/i);
  } finally {
    await cleanupCamp(campId);
  }
});
