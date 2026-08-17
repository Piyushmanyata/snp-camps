import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { PRINT_WINDOW_CLOSED } from "../src/lib/print-window.ts";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const VENUE = "print-window-test";

/** @type {pg.Client | null} */
let client = null;
let dbAvailable = false;

test.before(async () => {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await c.connect();
    client = c;
    dbAvailable = true;
  } catch {
    try {
      await c.end();
    } catch {
      /* ignore */
    }
    console.warn(
      "[print-window.db] local Postgres unavailable — DB tests skipped",
    );
  }
});

test.after(async () => {
  if (!client) return;
  try {
    await client.query(
      `update public.camps set is_active = false where is_active = true`,
    );
  } catch {
    /* ignore */
  }
  await client.end();
});

function skipIfNoDb(t) {
  if (!dbAvailable) {
    t.skip("local Postgres not available");
    return true;
  }
  return false;
}

async function asStaff(userId, fn) {
  await client.query("begin");
  try {
    await client.query(
      `select set_config('request.jwt.claim.role', 'authenticated', true)`,
    );
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      userId,
    ]);
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

async function seedProfile(role) {
  const userId = randomUUID();
  await client.query(
    `insert into auth.users (
       id, instance_id, aud, role, email,
       encrypted_password, email_confirmed_at,
       raw_app_meta_data, raw_user_meta_data,
       confirmation_token, recovery_token, email_change,
       email_change_token_new, email_change_token_current,
       phone_change, phone_change_token, reauthentication_token,
       created_at, updated_at
     ) values (
       $1,
       '00000000-0000-0000-0000-000000000000',
       'authenticated', 'authenticated',
       $2,
       crypt('test-password-long', gen_salt('bf')),
       now(),
       '{"provider":"email","providers":["email"]}'::jsonb,
       '{}'::jsonb,
       '', '', '', '', '', '', '', '',
       now(), now()
     )`,
    [userId, `pw-${role}-${userId.slice(0, 8)}@example.test`],
  );
  await client.query(
    `insert into public.profiles (id, role, full_name, email)
     values ($1, $2, $3, $4)
     on conflict (id) do update set role = $2, disabled_at = null`,
    [userId, role, `Print window ${role}`, `pw-${role}-${userId.slice(0, 8)}@example.test`],
  );
  return userId;
}

async function seedCamp() {
  const campId = randomUUID();
  const todayDayId = randomUUID();
  const futureDayId = randomUUID();
  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock(918273646)");
    await client.query(
      `delete from public.patients where camp_id in (
         select id from public.camps where venue = $1)`,
      [VENUE],
    );
    await client.query(
      `delete from public.camp_days where camp_id in (
         select id from public.camps where venue = $1)`,
      [VENUE],
    );
    await client.query(`delete from public.camps where venue = $1`, [VENUE]);
    await client.query(
      `update public.camps set is_active = false where is_active = true`,
    );
    await client.query(
      `insert into public.camps (id, name, is_active, venue)
       values ($1, $2, true, $3)`,
      [campId, `Print window ${campId.slice(0, 8)}`, VENUE],
    );
    const { rows: todayRows } = await client.query(
      `select (timezone('Asia/Kolkata', now()))::date as d`,
    );
    const today = todayRows[0].d;
    await client.query(
      `insert into public.camp_days (id, camp_id, day_date, seat_limit)
       values ($1, $2, $3, 50), ($4, $2, '2099-12-01', 50)`,
      [todayDayId, campId, today, futureDayId],
    );
    await client.query("commit");
    return { campId, todayDayId, futureDayId, today };
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

async function register(campId, dayId, name, staffId) {
  await client.query("begin");
  try {
    await client.query(
      `select set_config('request.jwt.claim.role', 'service_role', true)`,
    );
    const { rows } = await client.query(
      `select * from public.register_patient_idempotent(
         $1, $2, $3, 'M', 40, 'Ward 1', null, null, null,
         null, $4, $5, false, false, false, 'self_declared', null, null, null)`,
      [randomUUID(), campId, name, staffId, dayId],
    );
    await client.query("commit");
    return rows[0];
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

test("new camp days start with printing_open false", async (t) => {
  if (skipIfNoDb(t)) return;
  const { todayDayId, futureDayId } = await seedCamp();
  const { rows } = await client.query(
    `select id, printing_open from public.camp_days where id = any($1::uuid[])`,
    [[todayDayId, futureDayId]],
  );
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.printing_open === false));
});

test("mark_patient_printed refuses while the print window is closed", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedProfile("volunteer");
  const { campId, todayDayId } = await seedCamp();
  const patient = await register(campId, todayDayId, "Closed Window", staffId);

  await assert.rejects(
    () =>
      asStaff(staffId, async () => {
        await client.query(`select * from public.mark_patient_printed($1, null)`, [
          patient.id,
        ]);
      }),
    (err) => String(err.message).includes(PRINT_WINDOW_CLOSED),
  );

  const { rows } = await client.query(
    `select printed_at from public.patients where id = $1`,
    [patient.id],
  );
  assert.equal(rows[0].printed_at, null);
});

test("mark_patient_printed refuses when the flag is on for a future day", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedProfile("volunteer");
  const { campId, futureDayId } = await seedCamp();
  await client.query(
    `update public.camp_days set printing_open = true where id = $1`,
    [futureDayId],
  );
  const patient = await register(campId, futureDayId, "Wrong Day", staffId);

  await assert.rejects(
    () =>
      asStaff(staffId, async () => {
        await client.query(`select * from public.mark_patient_printed($1, null)`, [
          patient.id,
        ]);
      }),
    (err) => String(err.message).includes(PRINT_WINDOW_CLOSED),
  );
});

test("mark_patient_printed succeeds when open and writes presence once", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedProfile("volunteer");
  const { campId, todayDayId } = await seedCamp();
  await client.query(
    `update public.camp_days set printing_open = true where id = $1`,
    [todayDayId],
  );
  const patient = await register(campId, todayDayId, "Open Window", staffId);

  const first = await asStaff(staffId, async () => {
    const { rows } = await client.query(
      `select * from public.mark_patient_printed($1, null)`,
      [patient.id],
    );
    return rows[0];
  });
  assert.equal(first.already_printed, false);
  assert.equal(first.queue_status, "registered");

  const afterFirst = await client.query(
    `select printed_at, queued_at, queue_status from public.patients where id = $1`,
    [patient.id],
  );
  assert.notEqual(afterFirst.rows[0].printed_at, null);
  assert.equal(afterFirst.rows[0].queued_at, null);
  const firstStamp = String(afterFirst.rows[0].printed_at);

  await new Promise((resolve) => setTimeout(resolve, 50));

  const second = await asStaff(staffId, async () => {
    const { rows } = await client.query(
      `select * from public.mark_patient_printed($1, null)`,
      [patient.id],
    );
    return rows[0];
  });
  assert.equal(second.already_printed, true);

  const afterSecond = await client.query(
    `select printed_at from public.patients where id = $1`,
    [patient.id],
  );
  assert.equal(String(afterSecond.rows[0].printed_at), firstStamp);
});

test("set_camp_day_printing_open is admin only", async (t) => {
  if (skipIfNoDb(t)) return;
  const volunteerId = await seedProfile("volunteer");
  const adminId = await seedProfile("admin");
  const { todayDayId } = await seedCamp();

  await assert.rejects(
    () =>
      asStaff(volunteerId, async () => {
        await client.query(
          `select * from public.set_camp_day_printing_open($1, true)`,
          [todayDayId],
        );
      }),
    /admin only/i,
  );

  const opened = await asStaff(adminId, async () => {
    const { rows } = await client.query(
      `select printing_open from public.set_camp_day_printing_open($1, true)`,
      [todayDayId],
    );
    return rows[0];
  });
  assert.equal(opened.printing_open, true);
});

test("upsert_camp_day still refuses a seat limit below assigned", async (t) => {
  if (skipIfNoDb(t)) return;
  const adminId = await seedProfile("admin");
  const volunteerId = await seedProfile("volunteer");
  const { campId, todayDayId } = await seedCamp();
  await register(campId, todayDayId, "Taken Seat", volunteerId);

  await assert.rejects(
    () =>
      asStaff(adminId, async () => {
        await client.query(
          `select * from public.upsert_camp_day($1, $2, 0, $3)`,
          [campId, "2099-01-01", todayDayId],
        );
      }),
    /SEAT_LIMIT_BELOW_ASSIGNED/,
  );
});
