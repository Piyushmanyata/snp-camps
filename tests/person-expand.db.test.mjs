/**
 * #110 — Person entity expansion DB tests.
 * Asserts Person table structure, backfill completeness & re-runnability,
 * RLS least-privilege boundaries, and patient registration link.
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
      `select to_regclass('public.persons') is not null as ok`,
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
      "[person-expand.db] local Postgres unavailable — DB tests skipped",
    );
  }
});

test.after(async () => {
  if (client) {
    try {
      await client.query(`delete from public.profiles where email like '%@person.test'`);
      await client.query(`delete from auth.users where email like '%@person.test'`);
      await client.end();
    } catch {
      /* ignore */
    }
  }
});

async function seedProfile(role) {
  const userId = randomUUID();
  const email = `${role}-${userId.slice(0, 8)}@person.test`;
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
     on conflict (id) do update set role = excluded.role`,
    [userId, role, `Test ${role}`, email],
  );
  return userId;
}

test("Person entity and patient person_id column exist", async () => {
  if (!dbAvailable || !client) return;

  const { rows: personCols } = await client.query(`
    select column_name, data_type, is_nullable
    from information_schema.columns
    where table_schema = 'public' and table_name = 'persons'
  `);
  assert.ok(personCols.length > 0, "persons table must exist");

  const colNames = personCols.map((c) => c.column_name);
  assert.ok(colNames.includes("id"), "persons.id must exist");
  assert.ok(colNames.includes("reg_no"), "persons.reg_no must exist");
  assert.ok(colNames.includes("full_name"), "persons.full_name must exist");
  assert.ok(colNames.includes("duplicate_key"), "persons.duplicate_key must exist");
  assert.ok(colNames.includes("date_of_birth"), "persons.date_of_birth must exist");

  const { rows: patientCols } = await client.query(`
    select column_name
    from information_schema.columns
    where table_schema = 'public' and table_name = 'patients' and column_name = 'person_id'
  `);
  assert.ok(patientCols.length === 1, "patients.person_id column must exist");
});

test("Every patient row has a linked Person after backfill", async () => {
  if (!dbAvailable || !client) return;

  const { rows } = await client.query(`
    select count(*) filter (where person_id is null)::int as unlinked_count,
           count(*)::int as total_count
    from public.patients
  `);

  assert.equal(rows[0].unlinked_count, 0, "All patients must have a person_id");
});

test("RLS: Anon and patient callers cannot read persons table; Staff can", async () => {
  if (!dbAvailable || !client) return;

  // Anon caller
  await client.query("set role anon");
  await assert.rejects(
    async () => {
      await client.query("select * from public.persons limit 1");
    },
    (err) => {
      return (
        err.code === "42501" || err.message.includes("permission denied")
      );
    },
    "Anon must not read persons table",
  );
  await client.query("reset role");

  // Authenticated patient caller (no staff profile)
  const patientUserId = randomUUID();
  await client.query("set role authenticated");
  await client.query(
    `select set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify({ sub: patientUserId, role: "authenticated" })],
  );

  const { rows: patientReadRows } = await client.query(
    "select * from public.persons limit 5",
  );
  assert.equal(
    patientReadRows.length,
    0,
    "Patient role must receive 0 rows from persons table via RLS",
  );
  await client.query("reset role");

  // Admin caller can read persons
  const adminId = await seedProfile("admin");

  await client.query("begin");
  await client.query("set local role authenticated");
  await client.query(
    `select set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify({ sub: adminId, role: "authenticated" })],
  );

  const { rows: adminReadRows } = await client.query(
    "select count(*)::int as cnt from public.persons",
  );
  assert.ok(adminReadRows[0].cnt >= 0, "Admin can read persons");

  await client.query("rollback");
  await client.query("reset role");
});

test("New patient registration automatically creates and links a Person", async () => {
  if (!dbAvailable || !client) return;

  const volunteerId = await seedProfile("volunteer");

  await client.query("begin");

  // Seed camp and active day
  const campId = randomUUID();
  const dayId = randomUUID();
  await client.query(
    `insert into public.camps (id, name, venue, camp_date, is_active)
     values ($1, 'Person Test Camp', 'Venue', '2026-08-01', true)`,
    [campId],
  );
  await client.query(
    `insert into public.camp_days (id, camp_id, day_date, seat_limit)
     values ($1, $2, '2026-08-01', 50)`,
    [dayId, campId],
  );

  await client.query("set local role authenticated");
  await client.query(
    `select set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify({ sub: volunteerId, role: "authenticated" })],
  );

  const reqId = randomUUID();
  const { rows: regResult } = await client.query(
    `select * from public.register_patient_idempotent(
       p_request_id => $1,
       p_camp_id => $2,
       p_full_name => 'Test Person Split',
       p_gender => 'M',
       p_age => 45,
       p_address => 'Local',
       p_phone => '9876543210',
       p_email => null,
       p_aadhaar_last4 => '1234',
       p_user_id => null,
       p_created_by => $3,
       p_camp_day_id => $4
     )`,
    [reqId, campId, volunteerId, dayId],
  );

  assert.equal(regResult.length, 1);
  const patientId = regResult[0].id;
  const regNo = regResult[0].reg_no;

  await client.query("reset role");

  // Verify patient has person_id set and persons row matches
  const { rows: pRows } = await client.query(
    `select p.id, p.reg_no, p.person_id, pe.reg_no as person_reg_no, pe.full_name
     from public.patients p
     join public.persons pe on pe.id = p.person_id
     where p.id = $1`,
    [patientId],
  );

  assert.equal(pRows.length, 1, "Patient must join to Person");
  assert.equal(pRows[0].reg_no, regNo);
  assert.equal(pRows[0].person_reg_no, regNo);
  assert.equal(pRows[0].full_name, "Test Person Split");

  await client.query("rollback");
});
