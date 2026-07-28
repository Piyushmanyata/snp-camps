/**
 * #57 — assign_patient_doctor must enforce waiting → seen only.
 * Real authenticated doctor/volunteer JWTs; FOR UPDATE state machine.
 * Venue: assign-lifecycle-test (cleaned in test.after).
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const VENUE = "assign-lifecycle-test";

/** @type {pg.Client | null} */
let client = null;
let dbAvailable = false;

async function connect() {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await c.connect();
    const { rows } = await c.query(
      `select to_regprocedure('public.assign_patient_doctor(uuid,integer,uuid)') is not null as ok`,
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
      "[assign-waiting-before-seen.db] local Postgres unavailable — DB tests skipped",
    );
  }
});

test.after(async () => {
  if (client) {
    try {
      await client.query(
        `delete from public.patients where camp_id in (
           select id from public.camps where venue = $1
         )`,
        [VENUE],
      );
      await client.query(
        `delete from public.camp_days where camp_id in (
           select id from public.camps where venue = $1
         )`,
        [VENUE],
      );
      await client.query(`delete from public.camps where venue = $1`, [VENUE]);
      await client.query(
        `delete from public.profiles where email like '%@assign-lifecycle.test'`,
      );
      await client.query(
        `delete from auth.users where email like '%@assign-lifecycle.test'`,
      );
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

/** Run SECURITY DEFINER registration under service_role JWT claims. */
async function asServiceRole(fn) {
  await client.query("begin");
  try {
    await client.query(
      `select set_config('request.jwt.claim.role', 'service_role', true)`,
    );
    const result = await fn();
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

/**
 * @param {string} userId
 * @param {(c: pg.Client) => Promise<unknown>} fn
 */
async function asAuthenticated(userId, fn) {
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
    await client.query(`set local role authenticated`);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/** @param {"admin"|"team_lead"|"volunteer"|"doctor"} role */
async function seedProfile(role) {
  const userId = randomUUID();
  const email = `${role}-${userId.slice(0, 8)}@assign-lifecycle.test`;
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
       crypt('test-password-long', gen_salt('bf')),
       now(),
       '{"provider":"email","providers":["email"]}'::jsonb,
       '{}'::jsonb,
       now(), now()
     )`,
    [userId, email],
  );
  await client.query(
    `insert into public.profiles (id, role, full_name, email)
     values ($1, $2, $3, $4)
     on conflict (id) do update set role = excluded.role, disabled_at = null`,
    [userId, role, `Test ${role}`, email],
  );
  return userId;
}

async function seedCampFutureDay() {
  const campId = randomUUID();
  const dayId = randomUUID();
  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock(918273646)");
    await client.query(
      `delete from public.patients where camp_id in (
         select id from public.camps where venue = $1
       )`,
      [VENUE],
    );
    await client.query(
      `delete from public.camp_days where camp_id in (
         select id from public.camps where venue = $1
       )`,
      [VENUE],
    );
    await client.query(`delete from public.camps where venue = $1`, [VENUE]);
    await client.query(
      `update public.camps set is_active = false where is_active = true`,
    );
    await client.query(
      `insert into public.camps (id, name, is_active, venue)
       values ($1, $2, true, $3)`,
      [campId, `Assign lifecycle ${campId.slice(0, 8)}`, VENUE],
    );
    await client.query(
      `insert into public.camp_days (id, camp_id, day_date, seat_limit)
       values ($1, $2, '2099-07-15', 50)`,
      [dayId, campId],
    );
    await client.query("commit");
    return { campId, dayId };
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

async function registerPatient(campId, dayId, name) {
  return asServiceRole(async () => {
    const { rows } = await client.query(
      `select * from public.register_patient_idempotent(
         $1, $2, $3, 'M', 40, 'Ward A', null, null, null,
         null, null, $4, false, false
       )`,
      [randomUUID(), campId, name, dayId],
    );
    return rows[0];
  });
}

async function snapshotPatient(id) {
  const { rows } = await client.query(
    `select queue_status, seen_at, seen_by, queued_at, checked_in_by
     from public.patients where id = $1`,
    [id],
  );
  return rows[0];
}

test("doctor assign of registered returns check_in_required and leaves row unchanged", async (t) => {
  if (skipIfNoDb(t)) return;
  const doctorId = await seedProfile("doctor");
  const { campId, dayId } = await seedCampFutureDay();
  const patient = await registerPatient(campId, dayId, "Registered Only");
  assert.equal(patient.queue_status, "registered");
  const before = await snapshotPatient(patient.id);

  const result = await asAuthenticated(doctorId, async (c) => {
    const { rows } = await c.query(
      `select * from public.assign_patient_doctor($1, null, null)`,
      [patient.id],
    );
    return rows[0];
  });

  assert.equal(result.error_code, "check_in_required");
  assert.equal(result.queue_status, "registered");
  assert.equal(result.already_seen, false);
  assert.equal(result.doctor_id, null);

  const after = await snapshotPatient(patient.id);
  assert.equal(after.queue_status, "registered");
  assert.equal(after.seen_at, null);
  assert.equal(after.seen_by, null);
  assert.equal(after.queued_at, null);
  assert.equal(after.checked_in_by, before.checked_in_by);
});

test("volunteer assign of registered returns check_in_required", async (t) => {
  if (skipIfNoDb(t)) return;
  const volunteerId = await seedProfile("volunteer");
  const doctorId = await seedProfile("doctor");
  const { campId, dayId } = await seedCampFutureDay();
  const patient = await registerPatient(campId, dayId, "Vol Registered");

  const result = await asAuthenticated(volunteerId, async (c) => {
    const { rows } = await c.query(
      `select * from public.assign_patient_doctor($1, null, $2)`,
      [patient.id, doctorId],
    );
    return rows[0];
  });

  assert.equal(result.error_code, "check_in_required");
  assert.equal(result.queue_status, "registered");
  const after = await snapshotPatient(patient.id);
  assert.equal(after.queue_status, "registered");
  assert.equal(after.seen_at, null);
  assert.equal(after.seen_by, null);
});

test("Team Lead can perform the same doctor assignment as a volunteer", async (t) => {
  if (skipIfNoDb(t)) return;
  const teamLeadId = await seedProfile("team_lead");
  const volunteerId = await seedProfile("volunteer");
  const doctorId = await seedProfile("doctor");
  const { campId, dayId } = await seedCampFutureDay();
  const patient = await registerPatient(campId, dayId, "Team Lead Assignment");

  await asAuthenticated(volunteerId, async (c) => {
    await c.query(`select * from public.check_in_patient($1, null)`, [
      patient.id,
    ]);
  });

  const result = await asAuthenticated(teamLeadId, async (c) => {
    const { rows } = await c.query(
      `select * from public.assign_patient_doctor($1, null, $2)`,
      [patient.id, doctorId],
    );
    return rows[0];
  });

  assert.equal(result.error_code, null);
  assert.equal(result.queue_status, "seen");
  assert.equal(result.doctor_id, doctorId);
});

test("waiting patient transitions to seen once and preserves check-in fields", async (t) => {
  if (skipIfNoDb(t)) return;
  const volunteerId = await seedProfile("volunteer");
  const doctorId = await seedProfile("doctor");
  const { campId, dayId } = await seedCampFutureDay();
  const patient = await registerPatient(campId, dayId, "Waiting Patient");

  await asAuthenticated(volunteerId, async (c) => {
    await c.query(`select * from public.check_in_patient($1, null)`, [
      patient.id,
    ]);
  });

  const waiting = await snapshotPatient(patient.id);
  assert.equal(waiting.queue_status, "waiting");
  assert.ok(waiting.queued_at);
  assert.equal(waiting.checked_in_by, volunteerId);
  const queuedAt = String(waiting.queued_at);

  const assigned = await asAuthenticated(doctorId, async (c) => {
    const { rows } = await c.query(
      `select * from public.assign_patient_doctor($1, null, null)`,
      [patient.id],
    );
    return rows[0];
  });

  assert.equal(assigned.error_code, null);
  assert.equal(assigned.queue_status, "seen");
  assert.equal(assigned.already_seen, false);
  assert.equal(assigned.doctor_id, doctorId);

  const after = await snapshotPatient(patient.id);
  assert.equal(after.queue_status, "seen");
  assert.equal(after.seen_by, doctorId);
  assert.ok(after.seen_at);
  assert.equal(String(after.queued_at), queuedAt);
  assert.equal(after.checked_in_by, volunteerId);
});

test("repeat assign on seen is terminal and never reassigns doctor", async (t) => {
  if (skipIfNoDb(t)) return;
  const volunteerId = await seedProfile("volunteer");
  const doctorA = await seedProfile("doctor");
  const doctorB = await seedProfile("doctor");
  const { campId, dayId } = await seedCampFutureDay();
  const patient = await registerPatient(campId, dayId, "Seen Patient");

  await asAuthenticated(volunteerId, async (c) => {
    await c.query(`select * from public.check_in_patient($1, null)`, [
      patient.id,
    ]);
  });
  await asAuthenticated(doctorA, async (c) => {
    await c.query(`select * from public.assign_patient_doctor($1, null, null)`, [
      patient.id,
    ]);
  });

  const second = await asAuthenticated(doctorB, async (c) => {
    const { rows } = await c.query(
      `select * from public.assign_patient_doctor($1, null, null)`,
      [patient.id],
    );
    return rows[0];
  });

  assert.equal(second.error_code, "already_seen");
  assert.equal(second.already_seen, true);
  assert.equal(second.doctor_id, doctorA);
  assert.equal(second.queue_status, "seen");

  const after = await snapshotPatient(patient.id);
  assert.equal(after.seen_by, doctorA);
});

test("concurrent assign cannot produce different doctors or skip waiting rule", async (t) => {
  if (skipIfNoDb(t)) return;
  const volunteerId = await seedProfile("volunteer");
  const doctorA = await seedProfile("doctor");
  const doctorB = await seedProfile("doctor");
  const { campId, dayId } = await seedCampFutureDay();
  const patient = await registerPatient(campId, dayId, "Race Patient");

  await asAuthenticated(volunteerId, async (c) => {
    await c.query(`select * from public.check_in_patient($1, null)`, [
      patient.id,
    ]);
  });

  const c1 = new pg.Client({ connectionString: DATABASE_URL });
  const c2 = new pg.Client({ connectionString: DATABASE_URL });
  await c1.connect();
  await c2.connect();

  async function assignAs(c, doctorId) {
    await c.query("begin");
    await c.query(
      `select set_config('request.jwt.claim.role', 'authenticated', true)`,
    );
    await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      doctorId,
    ]);
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ role: "authenticated", sub: doctorId }),
    ]);
    await c.query(`set local role authenticated`);
    const { rows } = await c.query(
      `select * from public.assign_patient_doctor($1, null, null)`,
      [patient.id],
    );
    await c.query("commit");
    return rows[0];
  }

  try {
    const [r1, r2] = await Promise.all([
      assignAs(c1, doctorA),
      assignAs(c2, doctorB),
    ]);

    const outcomes = [r1, r2];
    const successes = outcomes.filter(
      (r) => r.error_code == null && r.queue_status === "seen" && !r.already_seen,
    );
    const terminals = outcomes.filter(
      (r) => r.error_code === "already_seen" || r.already_seen,
    );

    assert.equal(successes.length, 1, "exactly one first-time assignment");
    assert.equal(terminals.length, 1, "other call is terminal already_seen");

    const winner = successes[0].doctor_id;
    assert.ok(winner === doctorA || winner === doctorB);
    assert.equal(terminals[0].doctor_id, winner);

    const after = await snapshotPatient(patient.id);
    assert.equal(after.seen_by, winner);
    assert.equal(after.queue_status, "seen");
  } finally {
    await c1.end().catch(() => {});
    await c2.end().catch(() => {});
  }
});
