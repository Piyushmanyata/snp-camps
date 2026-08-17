/**
 * D22/D25 — mark_seen requires presence (printed_at) and stays idempotent.
 * Real authenticated staff JWTs; FOR UPDATE state machine.
 * Venue: assign-lifecycle-test (cleaned in test.after).
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const VENUE = "assign-lifecycle-test";

/** @type {pg.Client | null} */
let client = null;
let dbAvailable = false;

async function connect() {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await c.connect();
    // Only a genuinely unreachable database may skip these tests. A missing
    // RPC is a real failure and must surface as one — the previous version of
    // this guard reported it as "Postgres unavailable" and silently skipped.
    await c.query("select 1");
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
      "[mark-seen-lifecycle.db] local Postgres unavailable — DB tests skipped",
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

/** @param {"admin"|"team_lead"|"volunteer"} role */
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
      `insert into public.camp_days (id, camp_id, day_date, seat_limit, printing_open)
       values ($1, $2, (timezone('Asia/Kolkata', now()))::date, 50, true)`,
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
         null, null, $4, false, false, false, 'self_declared', null, null, null)`,
      [randomUUID(), campId, name, dayId],
    );
    return rows[0];
  });
}

async function snapshotPatient(id) {
  const { rows } = await client.query(
    `select queue_status, seen_at, seen_by, printed_at, checked_in_by
     from public.patients where id = $1`,
    [id],
  );
  return rows[0];
}


test("mark_seen on a registered patient refuses and leaves the row untouched", async (t) => {
  if (skipIfNoDb(t)) return;
  const volunteerId = await seedProfile("volunteer");
  const { campId, dayId } = await seedCampFutureDay();
  const patient = await registerPatient(campId, dayId, "Registered Only");
  assert.equal(patient.queue_status, "registered");
  const before = await snapshotPatient(patient.id);

  const result = await asAuthenticated(volunteerId, async (c) => {
    const { rows } = await c.query(
      `select * from public.mark_seen($1, null)`,
      [patient.id],
    );
    return rows[0];
  });

  assert.equal(result.error_code, "never_printed");
  assert.equal(result.queue_status, "registered");
  assert.equal(result.already_seen, false);

  const after = await snapshotPatient(patient.id);
  assert.equal(after.queue_status, "registered");
  assert.equal(after.printed_at, null);
  assert.equal(after.seen_at, null);
  assert.equal(after.seen_by, null);

  assert.equal(after.checked_in_by, before.checked_in_by);
});

test("printing records presence and mark_seen records the staff member who scanned", async (t) => {
  if (skipIfNoDb(t)) return;
  const volunteerId = await seedProfile("volunteer");
  const markerId = await seedProfile("volunteer");
  const { campId, dayId } = await seedCampFutureDay();
  const patient = await registerPatient(campId, dayId, "Printed Patient");

  await asAuthenticated(volunteerId, async (c) => {
    await c.query(`select * from public.mark_patient_printed($1, null)`, [
      patient.id,
    ]);
  });

  const printed = await snapshotPatient(patient.id);
  assert.equal(printed.queue_status, "registered", "print does not move status");
  assert.ok(printed.printed_at);
  assert.equal(printed.checked_in_by, volunteerId);
  const printedAt = String(printed.printed_at);

  const seen = await asAuthenticated(markerId, async (c) => {
    const { rows } = await c.query(`select * from public.mark_seen($1, null)`, [
      patient.id,
    ]);
    return rows[0];
  });

  assert.equal(seen.error_code, null);
  assert.equal(seen.queue_status, "seen");
  assert.equal(seen.already_seen, false);

  const after = await snapshotPatient(patient.id);
  assert.equal(after.queue_status, "seen");
  // seen_by is the volunteer who scanned, not a doctor (D22).
  assert.equal(after.seen_by, markerId);
  assert.ok(after.seen_at);
  // Presence and its attribution survive being marked seen.
  assert.equal(String(after.printed_at), printedAt);
  assert.equal(after.checked_in_by, volunteerId);
});

test("a team lead may mark seen exactly as a volunteer does", async (t) => {
  if (skipIfNoDb(t)) return;
  const teamLeadId = await seedProfile("team_lead");
  const volunteerId = await seedProfile("volunteer");
  const { campId, dayId } = await seedCampFutureDay();
  const patient = await registerPatient(campId, dayId, "Team Lead Marks Seen");

  await asAuthenticated(volunteerId, async (c) => {
    await c.query(`select * from public.mark_patient_printed($1, null)`, [
      patient.id,
    ]);
  });

  const result = await asAuthenticated(teamLeadId, async (c) => {
    const { rows } = await c.query(`select * from public.mark_seen($1, null)`, [
      patient.id,
    ]);
    return rows[0];
  });

  assert.equal(result.error_code, null);
  assert.equal(result.queue_status, "seen");
  const after = await snapshotPatient(patient.id);
  assert.equal(after.seen_by, teamLeadId);
});

test("a second scan is terminal and never re-stamps seen_at or seen_by", async (t) => {
  if (skipIfNoDb(t)) return;
  const volunteerId = await seedProfile("volunteer");
  const firstMarker = await seedProfile("volunteer");
  const secondMarker = await seedProfile("volunteer");
  const { campId, dayId } = await seedCampFutureDay();
  const patient = await registerPatient(campId, dayId, "Seen Patient");

  await asAuthenticated(volunteerId, async (c) => {
    await c.query(`select * from public.mark_patient_printed($1, null)`, [
      patient.id,
    ]);
  });
  await asAuthenticated(firstMarker, async (c) => {
    await c.query(`select * from public.mark_seen($1, null)`, [patient.id]);
  });
  const firstState = await snapshotPatient(patient.id);

  const second = await asAuthenticated(secondMarker, async (c) => {
    const { rows } = await c.query(`select * from public.mark_seen($1, null)`, [
      patient.id,
    ]);
    return rows[0];
  });

  assert.equal(second.error_code, "already_seen");
  assert.equal(second.already_seen, true);
  assert.equal(second.queue_status, "seen");

  const after = await snapshotPatient(patient.id);
  assert.equal(after.seen_by, firstMarker);
  assert.equal(String(after.seen_at), String(firstState.seen_at));
});

test("undo returns the patient to registered and keeps their presence", async (t) => {
  if (skipIfNoDb(t)) return;
  const volunteerId = await seedProfile("volunteer");
  const { campId, dayId } = await seedCampFutureDay();
  const patient = await registerPatient(campId, dayId, "Undo Patient");

  await asAuthenticated(volunteerId, async (c) => {
    await c.query(`select * from public.mark_patient_printed($1, null)`, [
      patient.id,
    ]);
  });
  const printed = await snapshotPatient(patient.id);
  await asAuthenticated(volunteerId, async (c) => {
    await c.query(`select * from public.mark_seen($1, null)`, [patient.id]);
  });

  const undone = await asAuthenticated(volunteerId, async (c) => {
    const { rows } = await c.query(
      `select * from public.undo_mark_seen($1)`,
      [patient.id],
    );
    return rows[0];
  });

  assert.equal(undone.error_code, null);
  assert.equal(undone.queue_status, "registered");

  const after = await snapshotPatient(patient.id);
  assert.equal(after.queue_status, "registered");
  assert.equal(after.seen_at, null);
  assert.equal(after.seen_by, null);
  // Presence survives, so no reprint is needed to mark them seen again.
  assert.equal(String(after.printed_at), String(printed.printed_at));

  // Undo is only valid against a seen row.
  const again = await asAuthenticated(volunteerId, async (c) => {
    const { rows } = await c.query(`select * from public.undo_mark_seen($1)`, [
      patient.id,
    ]);
    return rows[0];
  });
  assert.equal(again.error_code, "not_seen");
});

test("undo refuses to reopen a patient after the camp becomes inactive", async (t) => {
  if (skipIfNoDb(t)) return;
  const volunteerId = await seedProfile("volunteer");
  const { campId, dayId } = await seedCampFutureDay();
  const patient = await registerPatient(campId, dayId, "Inactive Undo Patient");

  await asAuthenticated(volunteerId, async (c) => {
    await c.query(`select * from public.mark_patient_printed($1, null)`, [
      patient.id,
    ]);
    await c.query(`select * from public.mark_seen($1, null)`, [patient.id]);
  });
  await client.query(`update public.camps set is_active = false where id = $1`, [
    campId,
  ]);

  const undone = await asAuthenticated(volunteerId, async (c) => {
    const { rows } = await c.query(`select * from public.undo_mark_seen($1)`, [
      patient.id,
    ]);
    return rows[0];
  });
  assert.equal(undone.error_code, "inactive_camp");
  assert.equal(undone.queue_status, "seen");
  assert.equal((await snapshotPatient(patient.id)).queue_status, "seen");
});

test("undo holds the camp lifecycle lock until its transition commits", async (t) => {
  if (skipIfNoDb(t)) return;
  const volunteerId = await seedProfile("volunteer");
  const { campId, dayId } = await seedCampFutureDay();
  const patient = await registerPatient(campId, dayId, "Undo Lock Patient");

  await asAuthenticated(volunteerId, async (c) => {
    await c.query(`select * from public.mark_patient_printed($1, null)`, [
      patient.id,
    ]);
    await c.query(`select * from public.mark_seen($1, null)`, [patient.id]);
  });

  const undoClient = new pg.Client({ connectionString: DATABASE_URL });
  const lifecycleClient = new pg.Client({ connectionString: DATABASE_URL });
  await undoClient.connect();
  await lifecycleClient.connect();
  try {
    await undoClient.query("begin");
    await undoClient.query(
      `select set_config('request.jwt.claim.role', 'authenticated', true)`,
    );
    await undoClient.query(
      `select set_config('request.jwt.claim.sub', $1, true)`,
      [volunteerId],
    );
    await undoClient.query(
      `select set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify({ role: "authenticated", sub: volunteerId })],
    );
    await undoClient.query(`set local role authenticated`);
    const { rows } = await undoClient.query(
      `select * from public.undo_mark_seen($1)`,
      [patient.id],
    );
    assert.equal(rows[0]?.error_code, null);

    await lifecycleClient.query(`set statement_timeout = '150ms'`);
    await assert.rejects(
      () =>
        lifecycleClient.query(
          `update public.camps set is_active = false where id = $1`,
          [campId],
        ),
      /statement timeout|canceling statement/i,
      "camp deactivation must wait while undo holds the lifecycle row lock",
    );

    await undoClient.query("commit");
    await lifecycleClient.query(`set statement_timeout = 0`);
    await lifecycleClient.query(
      `update public.camps set is_active = false where id = $1`,
      [campId],
    );

    const after = await snapshotPatient(patient.id);
    assert.equal(after.queue_status, "registered");
  } finally {
    await undoClient.query("rollback").catch(() => {});
    await lifecycleClient.query(`set statement_timeout = 0`).catch(() => {});
    await undoClient.end().catch(() => {});
    await lifecycleClient.end().catch(() => {});
  }
});

test("concurrent mark_seen produces exactly one first-time transition", async (t) => {
  if (skipIfNoDb(t)) return;
  const volunteerId = await seedProfile("volunteer");
  const markerA = await seedProfile("volunteer");
  const markerB = await seedProfile("volunteer");
  const { campId, dayId } = await seedCampFutureDay();
  const patient = await registerPatient(campId, dayId, "Race Patient");

  await asAuthenticated(volunteerId, async (c) => {
    await c.query(`select * from public.mark_patient_printed($1, null)`, [
      patient.id,
    ]);
  });

  const c1 = new pg.Client({ connectionString: DATABASE_URL });
  const c2 = new pg.Client({ connectionString: DATABASE_URL });
  await c1.connect();
  await c2.connect();

  async function markSeenAs(c, staffId) {
    await c.query("begin");
    await c.query(
      `select set_config('request.jwt.claim.role', 'authenticated', true)`,
    );
    await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      staffId,
    ]);
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ role: "authenticated", sub: staffId }),
    ]);
    await c.query(`set local role authenticated`);
    const { rows } = await c.query(`select * from public.mark_seen($1, null)`, [
      patient.id,
    ]);
    await c.query("commit");
    return rows[0];
  }

  try {
    const [r1, r2] = await Promise.all([
      markSeenAs(c1, markerA),
      markSeenAs(c2, markerB),
    ]);

    const outcomes = [r1, r2];
    const successes = outcomes.filter(
      (r) => r.error_code == null && r.queue_status === "seen" && !r.already_seen,
    );
    const terminals = outcomes.filter(
      (r) => r.error_code === "already_seen" || r.already_seen,
    );

    assert.equal(successes.length, 1, "exactly one first-time transition");
    assert.equal(terminals.length, 1, "other call is terminal already_seen");

    const after = await snapshotPatient(patient.id);
    assert.equal(after.queue_status, "seen");
    // Whoever won, the row records exactly one of them — never a blend.
    assert.ok(after.seen_by === markerA || after.seen_by === markerB);
  } finally {
    await c1.end().catch(() => {});
    await c2.end().catch(() => {});
  }
});
