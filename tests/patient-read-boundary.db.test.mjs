/**
 * #56 — Real-role patient read boundary and Realtime publication.
 * Uses SET LOCAL ROLE authenticated with JWT claims (not service_role).
 * All seeds run inside rolled-back transactions where practical; cleanup
 * still deactivates leftover test camps after the suite.
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
      `select to_regclass('public.patients') is not null as ok`,
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
      "[patient-read-boundary.db] local Postgres unavailable — DB tests skipped",
    );
  }
});

test.after(async () => {
  if (client) {
    try {
      // Remove synthetic fixtures so local E2E global-setup is not polluted.
      await client.query(
        `delete from public.patients where camp_id in (
           select id from public.camps where venue = 'boundary-test'
         )`,
      );
      await client.query(
        `delete from public.camp_days where camp_id in (
           select id from public.camps where venue = 'boundary-test'
         )`,
      );
      await client.query(
        `delete from public.camps where venue = 'boundary-test'`,
      );
      await client.query(
        `delete from public.profiles where email like '%@boundary.test'`,
      );
      await client.query(
        `delete from auth.users where email like '%@boundary.test'`,
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

/**
 * @param {string} userId
 * @param {(c: pg.Client) => Promise<unknown>} fn
 */
async function asAuthenticated(userId, fn) {
  await client.query("begin");
  try {
    await client.query(`select set_config('request.jwt.claim.role', 'authenticated', true)`);
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ role: "authenticated", sub: userId }),
    ]);
    await client.query(`set local role authenticated`);
    const result = await fn(client);
    await client.query("rollback");
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

/**
 * @param {"admin"|"volunteer"|"doctor"} role
 * @param {{ disabled?: boolean }} [opts]
 */
async function seedProfile(role, opts = {}) {
  const userId = randomUUID();
  const email = `${role}-${userId.slice(0, 8)}@boundary.test`;
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
    `insert into public.profiles (id, role, full_name, email, disabled_at)
     values ($1, $2, $3, $4, $5)
     on conflict (id) do update
       set role = excluded.role,
           disabled_at = excluded.disabled_at`,
    [
      userId,
      role,
      `Boundary ${role}`,
      email,
      opts.disabled ? new Date().toISOString() : null,
    ],
  );
  return userId;
}

async function seedActiveCampPatient() {
  const campId = randomUUID();
  const dayId = randomUUID();
  const patientId = randomUUID();
  const hexToken = (randomUUID() + randomUUID()).replace(/-/g, "").slice(0, 32);

  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock(918273646)");
    await client.query(
      `update public.camps set is_active = false where is_active = true`,
    );
    await client.query(
      `insert into public.camps (id, name, is_active, venue)
       values ($1, $2, true, 'boundary-test')`,
      [campId, `Boundary camp ${campId.slice(0, 8)}`],
    );
    await client.query(
      `insert into public.camp_days (id, camp_id, day_date, seat_limit)
       values ($1, $2, '2099-12-01', 50)`,
      [dayId, campId],
    );
    const regNo = 900000 + Math.floor(Math.random() * 99999);
    await client.query(
      `insert into public.patients (
         id, camp_id, camp_day_id, reg_no, full_name, gender, age,
         address, phone, email, aadhaar_last4, queue_status, status_token
       ) values (
         $1, $2, $3, $5, 'Unrelated Patient', 'M', 44,
         'Private Address Lane', '+919999000111', 'secret@example.test', '4321',
         'waiting', $4
       )`,
      [patientId, campId, dayId, hexToken, regNo],
    );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
  return { campId, dayId, patientId, token: hexToken };
}

async function seedInactiveCampPatient() {
  const campId = randomUUID();
  const dayId = randomUUID();
  const patientId = randomUUID();
  const token = (randomUUID() + randomUUID()).replace(/-/g, "").slice(0, 32);
  await client.query(
    `insert into public.camps (id, name, is_active, venue)
     values ($1, $2, false, 'boundary-test')`,
    [campId, `Inactive camp ${campId.slice(0, 8)}`],
  );
  await client.query(
    `insert into public.camp_days (id, camp_id, day_date, seat_limit)
     values ($1, $2, '2099-12-02', 50)`,
    [dayId, campId],
  );
  const regNo = 800000 + Math.floor(Math.random() * 99999);
  await client.query(
    `insert into public.patients (
       id, camp_id, camp_day_id, reg_no, full_name, gender, age,
       address, phone, email, aadhaar_last4, queue_status, status_token
     ) values (
       $1, $2, $3, $5, 'Inactive Camp Patient', 'F', 30,
       'Hidden Road', '+919999000222', 'hidden@example.test', '9999',
       'registered', $4
     )`,
    [patientId, campId, dayId, token, regNo],
  );
  return { campId, patientId, token };
}

test("doctor cannot select unrelated patient PHI or status_token", async (t) => {
  if (skipIfNoDb(t)) return;
  const doctorId = await seedProfile("doctor");
  const { patientId, token } = await seedActiveCampPatient();

  // PHI columns without status_token: RLS must hide the row entirely.
  const rows = await asAuthenticated(doctorId, async (c) => {
    const { rows: r } = await c.query(
      `select full_name, address, phone, email, aadhaar_last4
       from public.patients
       where id = $1`,
      [patientId],
    );
    return r;
  });

  assert.equal(rows.length, 0, "doctor must not see unrelated patient rows");

  // Column grant: status_token is not selectable by authenticated.
  await asAuthenticated(doctorId, async (c) => {
    await assert.rejects(
      () =>
        c.query(`select status_token from public.patients where id = $1`, [
          patientId,
        ]),
      /permission denied|column/i,
    );
  });

  // Prove token still exists for service/postgres (value redacted in evidence).
  const { rows: proof } = await client.query(
    `select length(status_token) as n from public.patients where id = $1`,
    [patientId],
  );
  assert.equal(proof[0].n, 32);
  assert.equal(token.length, 32);
});

test("volunteer can select active-camp desk fields but not status_token", async (t) => {
  if (skipIfNoDb(t)) return;
  const volunteerId = await seedProfile("volunteer");
  const { patientId } = await seedActiveCampPatient();

  const rows = await asAuthenticated(volunteerId, async (c) => {
    const { rows: r } = await c.query(
      `select full_name, address, phone, email, aadhaar_last4
       from public.patients
       where id = $1`,
      [patientId],
    );
    return r;
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].full_name, "Unrelated Patient");
  assert.equal(rows[0].phone, "+919999000111");

  await asAuthenticated(volunteerId, async (c) => {
    await assert.rejects(
      () =>
        c.query(`select status_token from public.patients where id = $1`, [
          patientId,
        ]),
      /permission denied|column/i,
    );
  });
});

test("admin can select active-camp patients but not status_token via table grant", async (t) => {
  if (skipIfNoDb(t)) return;
  const adminId = await seedProfile("admin");
  const { patientId } = await seedActiveCampPatient();

  const rows = await asAuthenticated(adminId, async (c) => {
    const { rows: r } = await c.query(
      `select full_name, phone from public.patients where id = $1`,
      [patientId],
    );
    return r;
  });
  assert.equal(rows.length, 1);

  await asAuthenticated(adminId, async (c) => {
    await assert.rejects(
      () =>
        c.query(`select status_token from public.patients where id = $1`, [
          patientId,
        ]),
      /permission denied|column/i,
    );
  });
});

test("disabled volunteer cannot select patients", async (t) => {
  if (skipIfNoDb(t)) return;
  const disabledId = await seedProfile("volunteer", { disabled: true });
  const { patientId } = await seedActiveCampPatient();

  const rows = await asAuthenticated(disabledId, async (c) => {
    const { rows: r } = await c.query(
      `select id from public.patients where id = $1`,
      [patientId],
    );
    return r;
  });
  assert.equal(rows.length, 0);
});

test("volunteer cannot select patients on inactive camp", async (t) => {
  if (skipIfNoDb(t)) return;
  const volunteerId = await seedProfile("volunteer");
  const { patientId } = await seedInactiveCampPatient();

  const rows = await asAuthenticated(volunteerId, async (c) => {
    const { rows: r } = await c.query(
      `select id from public.patients where id = $1`,
      [patientId],
    );
    return r;
  });
  assert.equal(rows.length, 0);
});

test("staff registration notify RPC returns status_token; doctor cannot", async (t) => {
  if (skipIfNoDb(t)) return;
  const volunteerId = await seedProfile("volunteer");
  const doctorId = await seedProfile("doctor");
  const { patientId, token } = await seedActiveCampPatient();

  const staffRows = await asAuthenticated(volunteerId, async (c) => {
    const { rows: r } = await c.query(
      `select * from public.patient_registration_notify_fields($1)`,
      [patientId],
    );
    return r;
  });
  assert.equal(staffRows.length, 1);
  assert.equal(staffRows[0].status_token, token);
  assert.ok(Number(staffRows[0].reg_no) >= 900000);

  await asAuthenticated(doctorId, async (c) => {
    await assert.rejects(
      () => c.query(`select * from public.patient_registration_notify_fields($1)`, [
        patientId,
      ]),
      /staff only/i,
    );
  });
});

test("patients table is absent from supabase_realtime publication", async (t) => {
  if (skipIfNoDb(t)) return;
  const { rows } = await client.query(
    `select 1
     from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'patients'`,
  );
  assert.equal(rows.length, 0, "patients must not be in supabase_realtime");
});
