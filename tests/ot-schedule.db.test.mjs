import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const VENUE = "ot-schedule-test";

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
    console.warn("[ot-schedule.db] local Postgres unavailable — DB tests skipped");
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
    [userId, `ot-${role}-${userId.slice(0, 8)}@example.test`],
  );
  await client.query(
    `insert into public.profiles (id, role, full_name, email)
     values ($1, $2, $3, $4)
     on conflict (id) do update set role = $2, disabled_at = null`,
    [userId, role, `OT ${role}`, `ot-${role}-${userId.slice(0, 8)}@example.test`],
  );
  return userId;
}

async function seedCamp() {
  const campId = randomUUID();
  const dayId = randomUUID();
  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock(918273647)");
    await client.query(
      `delete from public.fulfilment_items where ot_schedule_day_id in (
         select id from public.ot_schedule_days where camp_id in (
           select id from public.camps where venue = $1))`,
      [VENUE],
    );
    await client.query(
      `delete from public.ot_schedule_days where camp_id in (
         select id from public.camps where venue = $1)`,
      [VENUE],
    );
    await client.query(
      `delete from public.prescription_transcriptions where patient_id in (
         select id from public.patients where camp_id in (
           select id from public.camps where venue = $1))`,
      [VENUE],
    );
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
      [campId, `OT schedule ${campId.slice(0, 8)}`, VENUE],
    );
    await client.query(
      `insert into public.camp_days (id, camp_id, day_date, seat_limit)
       values ($1, $2, (timezone('Asia/Kolkata', now()))::date, 50)`,
      [dayId, campId],
    );
    await client.query("commit");
    return { campId, dayId };
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

async function seedDeferredOtItem(campId, campDayId, staffId, scheduleDayId) {
  await client.query("begin");
  try {
    await client.query(
      `select set_config('request.jwt.claim.role', 'service_role', true)`,
    );
    const { rows: patientRows } = await client.query(
      `select * from public.register_patient_idempotent(
         $1, $2, $3, 'M', 40, 'Ward 1', null, null, null,
         null, $4, $5, false, false, false, 'self_declared', null, null, null)`,
      [randomUUID(), campId, `OT Seat ${randomUUID().slice(0, 8)}`, staffId, campDayId],
    );
    const patientId = patientRows[0].id;
    const { rows: tRows } = await client.query(
      `insert into public.prescription_transcriptions
         (patient_id, data, created_by, updated_by)
       values ($1, '{}'::jsonb, $2, $2)
       returning id`,
      [patientId, staffId],
    );
    await client.query(
      `insert into public.fulfilment_items
         (transcription_id, kind, outcome, resolved_by, ot_schedule_day_id)
       values ($1, 'ot', 'deferred', $2, $3)`,
      [tRows[0].id, staffId, scheduleDayId],
    );
    await client.query("commit");
    return patientId;
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

test("pg_proc holds exactly one clinical_resolve_item overload, taking the schedule day", async (t) => {
  if (skipIfNoDb(t)) return;
  const { rows } = await client.query(
    `select pg_get_function_identity_arguments(p.oid) as args
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'clinical_resolve_item'`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].args, "uuid, text, text, text[], uuid");
});

test("clinical_resolve_item keeps EXECUTE for authenticated after the signature change", async (t) => {
  if (skipIfNoDb(t)) return;
  const { rows } = await client.query(
    `select
       has_function_privilege('authenticated', $1, 'EXECUTE') as authenticated,
       has_function_privilege('anon', $1, 'EXECUTE') as anon`,
    ["public.clinical_resolve_item(uuid,text,text,text[],uuid)"],
  );
  assert.equal(rows[0].authenticated, true);
  assert.equal(rows[0].anon, false);
});

test("upsert_ot_schedule_day refuses a seat limit below the number already assigned", async (t) => {
  if (skipIfNoDb(t)) return;
  const adminId = await seedProfile("admin");
  const volunteerId = await seedProfile("volunteer");
  const { campId, dayId } = await seedCamp();

  const created = await asStaff(adminId, async () => {
    const { rows } = await client.query(
      `select * from public.upsert_ot_schedule_day($1, '2099-03-01', 'OT theatre', 2)`,
      [campId],
    );
    return rows[0];
  });
  assert.equal(created.seat_limit, 2);

  await seedDeferredOtItem(campId, dayId, volunteerId, created.id);

  await assert.rejects(
    () =>
      asStaff(adminId, async () => {
        await client.query(
          `select * from public.upsert_ot_schedule_day($1, '2099-03-01', 'OT theatre', 0, $2)`,
          [campId, created.id],
        );
      }),
    /SEAT_LIMIT_BELOW_ASSIGNED:taken=1/,
  );

  await assert.rejects(
    () =>
      asStaff(adminId, async () => {
        await client.query(
          `select * from public.upsert_ot_schedule_day($1, '2099-03-01', 'OT theatre', 0)`,
          [campId],
        );
      }),
    /SEAT_LIMIT_BELOW_ASSIGNED:taken=1/,
    "the no-day-id path must apply the same guard as the update path",
  );

  const { rows: after } = await client.query(
    `select seat_limit from public.ot_schedule_days where id = $1`,
    [created.id],
  );
  assert.equal(after[0].seat_limit, 2);
});

test("upsert_ot_schedule_day is admin only", async (t) => {
  if (skipIfNoDb(t)) return;
  const volunteerId = await seedProfile("volunteer");
  const { campId } = await seedCamp();

  await assert.rejects(
    () =>
      asStaff(volunteerId, async () => {
        await client.query(
          `select * from public.upsert_ot_schedule_day($1, '2099-04-01', 'OT theatre', 3)`,
          [campId],
        );
      }),
    /admin only/i,
  );
});
