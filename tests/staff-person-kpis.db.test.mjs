/**
 * Real-database coverage for staff_person_kpis (#20 / D9).
 * Requires local Supabase Postgres (default 127.0.0.1:54322).
 *
 * - Active camp + p_camp_id → camp-scoped volunteer counts.
 * - Null p_camp_id → zeros (no all-time totals).
 * - volunteer_my_counts is dropped.
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
         'public.staff_person_kpis(uuid,text,uuid,timestamp with time zone)'
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
      "[staff-person-kpis.db] local Postgres unavailable or migration not applied — DB tests skipped",
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

async function seedVolunteer() {
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
    [userId, `vol-${userId.slice(0, 8)}@test.local`],
  );
  await client.query(
    `insert into public.profiles (id, role, full_name, email)
     values ($1, 'volunteer', 'KPI Test Volunteer', $2)
     on conflict (id) do update set role = excluded.role, disabled_at = null`,
    [userId, `vol-${userId.slice(0, 8)}@test.local`],
  );
  return userId;
}

async function cleanupVolunteer(userId) {
  await client.query(
    `update public.patients set created_by = null, checked_in_by = null
     where created_by = $1 or checked_in_by = $1`,
    [userId],
  );
  await client.query(`delete from public.profiles where id = $1`, [userId]);
  await client.query(`delete from auth.users where id = $1`, [userId]);
}

async function seedCampWithDay({ dayDate = "2099-07-01" } = {}) {
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
       values ($1, $2, true, 'kpi-test')`,
      [campId, `KPI camp ${campId.slice(0, 8)}`],
    );
    await client.query(
      `insert into public.camp_days (id, camp_id, day_date, seat_limit)
       values ($1, $2, $3::date, 100)`,
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

/** Call staff_person_kpis as the given JWT sub (volunteer or admin). */
async function callKpis(callerId, { userId, role, campId, since }) {
  await client.query("begin");
  try {
    await client.query(
      `select set_config('request.jwt.claim.role', 'authenticated', true)`,
    );
    await client.query(
      `select set_config('request.jwt.claim.sub', $1, true)`,
      [callerId],
    );
    const { rows } = await client.query(
      `select * from public.staff_person_kpis(
         $1::uuid, $2::text, $3::uuid, $4::timestamptz
       )`,
      [userId, role, campId, since],
    );
    await client.query("commit");
    return { ok: true, row: rows[0] ?? null };
  } catch (err) {
    await client.query("rollback");
    return { ok: false, message: String(err.message || err) };
  }
}

test("volunteer_my_counts is dropped from the catalog", async (t) => {
  if (skipIfNoDb(t)) return;
  const { rows } = await client.query(
    `select to_regprocedure(
       'public.volunteer_my_counts(timestamp with time zone)'
     ) is null as gone`,
  );
  assert.equal(rows[0].gone, true);
});

test("staff_person_kpis has one row shape and leaderboard has its own contract", async (t) => {
  if (skipIfNoDb(t)) return;
  const { rows } = await client.query(
    `select
       count(*) filter (where p.proname = 'staff_person_kpis')::integer as kpi_overloads,
       to_regprocedure('public.staff_leaderboard(uuid,uuid)') is not null as leaderboard_exists,
       to_regprocedure('public.staff_person_kpis(uuid,uuid)') is null as old_overload_gone
     from pg_proc p
     where p.pronamespace = 'public'::regnamespace`,
  );
  assert.equal(rows[0].kpi_overloads, 1);
  assert.equal(rows[0].leaderboard_exists, true);
  assert.equal(rows[0].old_overload_gone, true);
});

test("active camp yields camp-scoped volunteer counts", async (t) => {
  if (skipIfNoDb(t)) return;

  const volunteerId = await seedVolunteer();
  const { campId, dayId } = await seedCampWithDay();
  const otherCampId = randomUUID();
  const otherDayId = randomUUID();

  // Inactive second camp with a handled patient — must not count when scoped.
  await client.query(
    `insert into public.camps (id, name, is_active, venue)
     values ($1, 'Other KPI camp', false, 'kpi-other')`,
    [otherCampId],
  );
  await client.query(
    `insert into public.camp_days (id, camp_id, day_date, seat_limit)
     values ($1, $2, '2099-07-02'::date, 50)`,
    [otherDayId, otherCampId],
  );

  const since = new Date().toISOString();

  await client.query(
    `insert into public.patients (
       camp_id, camp_day_id, full_name, queue_status, created_by, created_at
     ) values
       ($1, $2, 'Handled Waiting', 'waiting', $3, now()),
       ($1, $2, 'Handled Seen', 'seen', $3, now()),
       ($4, $5, 'Other Camp', 'waiting', $3, now())`,
    [campId, dayId, volunteerId, otherCampId, otherDayId],
  );

  try {
    const { ok, row, message } = await callKpis(volunteerId, {
      userId: volunteerId,
      role: "volunteer",
      campId,
      since,
    });
    assert.equal(ok, true, message);
    assert.equal(Number(row.total), 2, "only active-camp patients");
    assert.equal(Number(row.today), 2);
    assert.equal(Number(row.waiting), 1);
    assert.equal(Number(row.seen), 1);
    assert.equal(row.label, "Patients handled");
  } finally {
    await cleanupCamp(campId);
    await cleanupCamp(otherCampId);
    await cleanupVolunteer(volunteerId);
  }
});

test("null p_camp_id yields zeros (no all-time totals)", async (t) => {
  if (skipIfNoDb(t)) return;

  const volunteerId = await seedVolunteer();
  const { campId, dayId } = await seedCampWithDay();
  const since = new Date().toISOString();

  await client.query(
    `insert into public.patients (
       camp_id, camp_day_id, full_name, queue_status, created_by
     ) values ($1, $2, 'Career Total Bait', 'waiting', $3)`,
    [campId, dayId, volunteerId],
  );

  try {
    // Even with real history, null camp id must not surface career totals.
    const nullCamp = await callKpis(volunteerId, {
      userId: volunteerId,
      role: "volunteer",
      campId: null,
      since,
    });
    assert.equal(nullCamp.ok, true, nullCamp.message);
    assert.equal(Number(nullCamp.row.total), 0);
    assert.equal(Number(nullCamp.row.today), 0);
    assert.equal(Number(nullCamp.row.waiting), 0);
    assert.equal(Number(nullCamp.row.seen), 0);
    assert.equal(nullCamp.row.label, "Patients handled");

    // Doctor role path also zeros with no camp.
    const doctorId = randomUUID();
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
      [doctorId, `doc-${doctorId.slice(0, 8)}@test.local`],
    );
    await client.query(
      `insert into public.profiles (id, role, full_name, email)
       values ($1, 'doctor', 'KPI Test Doctor', $2)`,
      [doctorId, `doc-${doctorId.slice(0, 8)}@test.local`],
    );

    try {
      const docZeros = await callKpis(doctorId, {
        userId: doctorId,
        role: "doctor",
        campId: null,
        since,
      });
      assert.equal(docZeros.ok, true, docZeros.message);
      assert.equal(Number(docZeros.row.total), 0);
      assert.equal(Number(docZeros.row.today), 0);
      assert.equal(docZeros.row.label, "Patients seen");
    } finally {
      await client.query(`delete from public.profiles where id = $1`, [
        doctorId,
      ]);
      await client.query(`delete from auth.users where id = $1`, [doctorId]);
    }
  } finally {
    await cleanupCamp(campId);
    await cleanupVolunteer(volunteerId);
  }
});
