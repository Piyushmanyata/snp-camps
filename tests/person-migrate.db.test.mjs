/**
 * #111 — Scanned Aadhaar registration migration to Person (global identity).
 * Verifies global one-Person-per-Aadhaar enforcement, same-camp return,
 * cross-camp returning patient reg_no retention, concurrency, and manual entry.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { createHash, randomUUID } from "node:crypto";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const personKey = (value) =>
  createHash("sha256").update(value).digest("hex");

/** @type {pg.Client | null} */
let client = null;
let dbAvailable = false;

async function connect() {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await c.connect();
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
      "[person-migrate.db] local Postgres unavailable — DB tests skipped",
    );
  }
});

test.after(async () => {
  if (client) {
    try {
      await client.query(`delete from public.profiles where email like '%@person-mig.test'`);
      await client.query(`delete from auth.users where email like '%@person-mig.test'`);
    } catch {
      /* ignore */
    } finally {
      // Must close even when cleanup throws (a failed test aborts the
      // transaction), or the open socket keeps the runner alive forever.
      await client.end().catch(() => {});
    }
  }
});

async function seedProfile(role) {
  const userId = randomUUID();
  const email = `${role}-${userId.slice(0, 8)}@person-mig.test`;
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

test("authenticated browsers cannot submit a chosen scanned Person key", async () => {
  if (!dbAvailable || !client) return;

  const volunteerId = await seedProfile("volunteer");
  const campId = randomUUID();
  const dayId = randomUUID();

  await client.query("begin");
  try {
    await client.query("update public.camps set is_active = false where is_active = true");
    await client.query(
      `insert into public.camps (id, name, venue, camp_date, is_active)
       values ($1, 'Trusted Boundary Camp', 'Venue', '2099-08-09', true)`,
      [campId],
    );
    await client.query(
      `insert into public.camp_days (id, camp_id, day_date, seat_limit)
       values ($1, $2, '2099-08-09', 50)`,
      [dayId, campId],
    );
    await client.query("set local role authenticated");
    await client.query(
      `select set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify({ sub: volunteerId, role: "authenticated" })],
    );

    await assert.rejects(
      client.query(
        `select id from public.register_patient_idempotent(
           p_request_id => $1,
           p_camp_id => $2,
           p_full_name => 'Forged Scan',
           p_gender => 'M',
           p_age => 40,
           p_address => null,
           p_phone => null,
           p_email => null,
           p_aadhaar_last4 => '1234',
           p_user_id => null,
           p_created_by => $3,
           p_camp_day_id => $4,
           p_aadhaar_duplicate_override => false,
           p_likely_duplicate_override => false,
           p_self_service => false,
           p_provenance => 'card_scanned',
           p_duplicate_key => 'attacker-chosen-key',
           p_date_of_birth => '1986-01-01'::date
         )`,
        [randomUUID(), campId, volunteerId, dayId],
      ),
      /scanned registration requires trusted server/i,
    );
  } finally {
    await client.query("rollback");
  }
});

test("Scanning an unseen card creates one Person and one Registration", async () => {
  if (!dbAvailable || !client) return;

  const volunteerId = await seedProfile("volunteer");
  const campId = randomUUID();
  const dayId = randomUUID();
  const dupKey = personKey(`key-unseen-${randomUUID()}`);

  await client.query("begin");
  await client.query("update public.camps set is_active = false where is_active = true");
  await client.query(
    `insert into public.camps (id, name, venue, camp_date, is_active)
     values ($1, 'Migrate Camp 1', 'Venue 1', '2099-08-10', true)`,
    [campId],
  );
  await client.query(
    `insert into public.camp_days (id, camp_id, day_date, seat_limit)
     values ($1, $2, '2099-08-10', 50)`,
    [dayId, campId],
  );

  await client.query("set role service_role");
  await client.query(
    `select set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify({ sub: volunteerId, role: "service_role" })],
  );

  const reqId = randomUUID();
  const { rows: regResult } = await client.query(
    `select * from public.register_patient_idempotent(
       p_request_id => $1,
       p_camp_id => $2,
       p_full_name => 'Ramesh Kumar',
       p_gender => 'M',
       p_age => 50,
       p_address => 'Sikar',
       p_phone => '9876543210',
       p_email => null,
       p_aadhaar_last4 => '9999',
       p_user_id => null,
       p_created_by => $3,
       p_camp_day_id => $4,
       p_aadhaar_duplicate_override => false,
       p_likely_duplicate_override => false,
       p_self_service => false,
       p_provenance => 'card_scanned',
       p_duplicate_key => $5,
       p_date_of_birth => '1976-05-15'::date
     )`,
    [reqId, campId, volunteerId, dayId, dupKey],
  );

  assert.equal(regResult.length, 1);
  const regNo = regResult[0].reg_no;

  await client.query("reset role");

  const { rows: personRows } = await client.query(
    `select * from public.persons where duplicate_key = $1`,
    [dupKey],
  );
  assert.equal(personRows.length, 1, "Exactly one Person created for new card");
  assert.equal(personRows[0].reg_no, regNo, "Person owns initial registration number");

  await client.query("rollback");
});

test("trusted scanned registration preserves the Team Lead creator", async () => {
  if (!dbAvailable || !client) return;

  const teamLeadId = await seedProfile("team_lead");
  const campId = randomUUID();
  const dayId = randomUUID();
  const duplicateKey = personKey(`key-team-lead-${randomUUID()}`);

  await client.query("begin");
  try {
    await client.query("update public.camps set is_active = false where is_active = true");
    await client.query(
      `insert into public.camps (id, name, venue, camp_date, is_active)
       values ($1, 'Team Lead Registration Camp', 'Venue TL', '2099-08-12', true)`,
      [campId],
    );
    await client.query(
      `insert into public.camp_days (id, camp_id, day_date, seat_limit)
       values ($1, $2, '2099-08-12', 50)`,
      [dayId, campId],
    );

    await client.query("set local role service_role");
    await client.query(
      `select set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify({ sub: teamLeadId, role: "service_role" })],
    );

    const { rows } = await client.query(
      `select *
       from public.register_patient_idempotent(
         p_request_id => $1,
         p_camp_id => $2,
         p_full_name => 'Team Lead Patient',
         p_gender => 'F',
         p_age => 36,
         p_address => 'Sikar',
         p_phone => '9876543210',
         p_email => null,
         p_aadhaar_last4 => '5555',
         p_user_id => null,
         p_created_by => $3,
         p_camp_day_id => $4,
         p_aadhaar_duplicate_override => false,
         p_likely_duplicate_override => false,
         p_self_service => false,
         p_provenance => 'card_scanned',
         p_duplicate_key => $5,
         p_date_of_birth => '1990-04-05'::date
       )`,
      [randomUUID(), campId, teamLeadId, dayId, duplicateKey],
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0].queue_status, "registered");

    // The point of this test: attribution survives the trusted scanned path.
    const { rows: stored } = await client.query(
      `select created_by from public.patients where id = $1`,
      [rows[0].id],
    );
    assert.equal(
      stored[0].created_by,
      teamLeadId,
      "Team Lead stays the original registrar",
    );
  } finally {
    await client.query("rollback");
  }
});

test("Scanning a card already registered in active Camp returns existing Registration", async () => {
  if (!dbAvailable || !client) return;

  const volunteerId = await seedProfile("volunteer");
  const campId = randomUUID();
  const dayId = randomUUID();
  const dupKey = personKey(`key-samecamp-${randomUUID()}`);

  await client.query("begin");
  await client.query("update public.camps set is_active = false where is_active = true");
  await client.query(
    `insert into public.camps (id, name, venue, camp_date, is_active)
     values ($1, 'Migrate Camp Same', 'Venue Same', '2099-08-11', true)`,
    [campId],
  );
  await client.query(
    `insert into public.camp_days (id, camp_id, day_date, seat_limit)
     values ($1, $2, '2099-08-11', 50)`,
    [dayId, campId],
  );

  await client.query("set role service_role");
  await client.query(
    `select set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify({ sub: volunteerId, role: "service_role" })],
  );

  // First scan
  const req1 = randomUUID();
  const { rows: reg1 } = await client.query(
    `select * from public.register_patient_idempotent(
       p_request_id => $1,
       p_camp_id => $2,
       p_full_name => 'Sunita Sharma',
       p_gender => 'F',
       p_age => 42,
       p_address => 'Jaipur',
       p_phone => '9876500000',
       p_email => null,
       p_aadhaar_last4 => '8888',
       p_user_id => null,
       p_created_by => $3,
       p_camp_day_id => $4,
       p_aadhaar_duplicate_override => false,
       p_likely_duplicate_override => false,
       p_self_service => false,
       p_provenance => 'card_scanned',
       p_duplicate_key => $5,
       p_date_of_birth => '1984-03-20'::date
     )`,
    [req1, campId, volunteerId, dayId, dupKey],
  );

  assert.equal(reg1.length, 1);
  const patientId1 = reg1[0].id;

  // Second scan of same card in same camp with DIFFERENT request_id
  const req2 = randomUUID();
  const { rows: reg2 } = await client.query(
    `select * from public.register_patient_idempotent(
       p_request_id => $1,
       p_camp_id => $2,
       p_full_name => 'Sunita Sharma',
       p_gender => 'F',
       p_age => 42,
       p_address => 'Jaipur',
       p_phone => '9876500000',
       p_email => null,
       p_aadhaar_last4 => '8888',
       p_user_id => null,
       p_created_by => $3,
       p_camp_day_id => $4,
       p_aadhaar_duplicate_override => false,
       p_likely_duplicate_override => false,
       p_self_service => false,
       p_provenance => 'card_scanned',
       p_duplicate_key => $5,
       p_date_of_birth => '1984-03-20'::date
     )`,
    [req2, campId, volunteerId, dayId, dupKey],
  );

  assert.equal(reg2.length, 1);
  assert.equal(reg2[0].id, patientId1, "Same registration row returned");

  await client.query("reset role");

  // Verify only 1 patient row exists in patients for this camp
  const { rows: pCount } = await client.query(
    `select count(*)::int as cnt from public.patients where camp_id = $1`,
    [campId],
  );
  assert.equal(pCount[0].cnt, 1, "No duplicate patient row created");

  await client.query("rollback");
});

test("Scanning card from previous Camp reuses Person entity across camps", async () => {
  if (!dbAvailable || !client) return;

  const volunteerId = await seedProfile("volunteer");
  const dupKey = personKey(`key-prevcamp-${randomUUID()}`);

  const camp1 = randomUUID();
  const day1 = randomUUID();
  const camp2 = randomUUID();
  const day2 = randomUUID();

  await client.query("begin");

  // Camp 1
  await client.query("update public.camps set is_active = false where is_active = true");
  await client.query(
    `insert into public.camps (id, name, venue, camp_date, is_active)
     values ($1, 'Camp 2026', 'Venue A', '2099-01-10', true)`,
    [camp1],
  );
  await client.query(
    `insert into public.camp_days (id, camp_id, day_date, seat_limit)
     values ($1, $2, '2099-01-10', 50)`,
    [day1, camp1],
  );

  await client.query("set role service_role");
  await client.query(
    `select set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify({ sub: volunteerId, role: "service_role" })],
  );

  const req1 = randomUUID();
  const { rows: reg1 } = await client.query(
    `select * from public.register_patient_idempotent(
       p_request_id => $1,
       p_camp_id => $2,
       p_full_name => 'Mohan Lal',
       p_gender => 'M',
       p_age => 60,
       p_address => 'Sikar',
       p_phone => '9988776655',
       p_email => null,
       p_aadhaar_last4 => '7777',
       p_user_id => null,
       p_created_by => $3,
       p_camp_day_id => $4,
       p_aadhaar_duplicate_override => false,
       p_likely_duplicate_override => false,
       p_self_service => false,
       p_provenance => 'card_scanned',
       p_duplicate_key => $5,
       p_date_of_birth => '1966-11-05'::date
     )`,
    [req1, camp1, volunteerId, day1, dupKey],
  );

  await client.query("reset role");
  const personId1 = (
    await client.query(`select person_id from public.patients where id = $1`, [
      reg1[0].id,
    ])
  ).rows[0].person_id;

  // Deactivate Camp 1 and Activate Camp 2
  await client.query("update public.camps set is_active = false where is_active = true");
  await client.query(
    `insert into public.camps (id, name, venue, camp_date, is_active)
     values ($1, 'Camp 2027', 'Venue B', '2099-02-15', true)`,
    [camp2],
  );
  await client.query(
    `insert into public.camp_days (id, camp_id, day_date, seat_limit)
     values ($1, $2, '2099-02-15', 50)`,
    [day2, camp2],
  );

  await client.query("set role service_role");
  await client.query(
    `select set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify({ sub: volunteerId, role: "service_role" })],
  );

  // Scan same card in Camp 2
  const req2 = randomUUID();
  const { rows: reg2 } = await client.query(
    `select * from public.register_patient_idempotent(
       p_request_id => $1,
       p_camp_id => $2,
       p_full_name => 'Mohan Lal',
       p_gender => 'M',
       p_age => 61,
       p_address => 'Sikar',
       p_phone => '9988776655',
       p_email => null,
       p_aadhaar_last4 => '7777',
       p_user_id => null,
       p_created_by => $3,
       p_camp_day_id => $4,
       p_aadhaar_duplicate_override => false,
       p_likely_duplicate_override => false,
       p_self_service => false,
       p_provenance => 'card_scanned',
       p_duplicate_key => $5,
       p_date_of_birth => '1966-11-05'::date
     )`,
    [req2, camp2, volunteerId, day2, dupKey],
  );

  assert.notEqual(reg2[0].id, reg1[0].id, "New Registration created for Camp 2");
  assert.equal(
    reg2[0].reg_no,
    reg1[0].reg_no,
    "Returning Person keeps the permanent registration number",
  );

  await client.query("reset role");

  const personId2 = (
    await client.query(`select person_id from public.patients where id = $1`, [
      reg2[0].id,
    ])
  ).rows[0].person_id;

  assert.equal(personId2, personId1, "Reuses the exact same Person entity across camps");

  const { rows: personRows } = await client.query(
    `select count(*)::int as cnt from public.persons where duplicate_key = $1`,
    [dupKey],
  );
  assert.equal(personRows[0].cnt, 1, "Exactly 1 Person entity exists in persons table");

  await client.query("set role service_role");
  await client.query(
    `select set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify({ sub: volunteerId, role: "service_role" })],
  );
  const { rows: activeLookup } = await client.query(
    `select id
     from public.lookup_patient_scan(
       p_patient_id => null,
       p_reg_no => $1
     )`,
    [reg1[0].reg_no],
  );
  assert.equal(
    activeLookup[0]?.id,
    reg2[0].id,
    "permanent number resolves to the active Camp Registration",
  );
  const { rows: printed } = await client.query(
    `select id
     from public.mark_patient_printed(
       p_patient_id => null,
       p_reg_no => $1
     )`,
    [reg1[0].reg_no],
  );
  assert.equal(
    printed[0]?.id,
    reg2[0].id,
    "printing by permanent number affects the active Camp Registration",
  );
  await client.query("reset role");

  await client.query("rollback");
});

test("Two concurrent scans of the same card produce exactly one Person", async () => {
  if (!dbAvailable || !client) return;

  const volunteerId = await seedProfile("volunteer");
  const dupKey = personKey(`key-concurrent-${randomUUID()}`);
  const campId = randomUUID();
  const dayId = randomUUID();

  // Setup active camp cleanly
  const setupClient = new pg.Client({ connectionString: DATABASE_URL });
  await setupClient.connect();
  await setupClient.query("update public.camps set is_active = false where is_active = true");
  await setupClient.query(
    `insert into public.camps (id, name, venue, camp_date, is_active)
     values ($1, 'Concurrent Camp', 'Venue C', '2099-09-01', true)`,
    [campId],
  );
  await setupClient.query(
    `insert into public.camp_days (id, camp_id, day_date, seat_limit)
     values ($1, $2, '2099-09-01', 50)`,
    [dayId, campId],
  );
  await setupClient.end();

  const c1 = new pg.Client({ connectionString: DATABASE_URL });
  const c2 = new pg.Client({ connectionString: DATABASE_URL });
  await c1.connect();
  await c2.connect();

  const runScan = async (c, reqId) => {
    await c.query("set role service_role");
    await c.query(
      `select set_config('request.jwt.claims', $1, false)`,
      [JSON.stringify({ sub: volunteerId, role: "service_role" })],
    );
    const res = await c.query(
      `select * from public.register_patient_idempotent(
         p_request_id => $1,
         p_camp_id => $2,
         p_full_name => 'Race Condition',
         p_gender => 'M',
         p_age => 30,
         p_address => 'Speed',
         p_phone => '9111111111',
         p_email => null,
         p_aadhaar_last4 => '1111',
         p_user_id => null,
         p_created_by => $3,
         p_camp_day_id => $4,
         p_aadhaar_duplicate_override => false,
         p_likely_duplicate_override => false,
         p_self_service => false,
         p_provenance => 'card_scanned',
         p_duplicate_key => $5,
         p_date_of_birth => '1996-01-01'::date
       )`,
      [reqId, campId, volunteerId, dayId, dupKey],
    );
    await c.query("reset role");
    return res;
  };

  const [res1, res2] = await Promise.all([
    runScan(c1, randomUUID()),
    runScan(c2, randomUUID()),
  ]);

  assert.equal(res1.rows.length, 1);
  assert.equal(res2.rows.length, 1);
  assert.equal(res1.rows[0].reg_no, res2.rows[0].reg_no, "Both scans yield same reg_no");

  const checkClient = new pg.Client({ connectionString: DATABASE_URL });
  await checkClient.connect();
  const { rows: personRows } = await checkClient.query(
    `select count(*)::int as cnt from public.persons where duplicate_key = $1`,
    [dupKey],
  );
  assert.equal(personRows[0].cnt, 1, "Exactly one Person row created across concurrent scans");
  await checkClient.end();

  await c1.end();
  await c2.end();
});
