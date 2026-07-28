/**
 * #112 — Aadhaar lock & name lock on Person entity.
 * Verifies lock setting during card registration, and exception throwing
 * when attempting to mutate locked identity fields (aadhaar_last4, full_name).
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { createHash, randomUUID } from "node:crypto";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
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
      "[person-lock.db] local Postgres unavailable — DB tests skipped",
    );
  }
});

test.after(async () => {
  if (client) {
    try {
      await client.query(`delete from public.profiles where email like '%@person-lock.test'`);
      await client.query(`delete from auth.users where email like '%@person-lock.test'`);
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
  const email = `${role}-${userId.slice(0, 8)}@person-lock.test`;
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

test("Card verification sets aadhaar_locked_at and name_locked_at on Person", async () => {
  if (!dbAvailable || !client) return;

  const volunteerId = await seedProfile("volunteer");
  const campId = randomUUID();
  const dayId = randomUUID();
  const dupKey = personKey(`key-lock-${randomUUID()}`);

  await client.query("begin");
  await client.query("update public.camps set is_active = false where is_active = true");
  await client.query(
    `insert into public.camps (id, name, venue, camp_date, is_active)
     values ($1, 'Lock Test Camp', 'Venue L', '2026-08-15', true)`,
    [campId],
  );
  await client.query(
    `insert into public.camp_days (id, camp_id, day_date, seat_limit)
     values ($1, $2, '2026-08-15', 50)`,
    [dayId, campId],
  );

  // Scanned-card writes cross the trusted server boundary and run as
  // service_role; authenticated browsers are forbidden from choosing a key.
  await client.query("set role service_role");
  await client.query(
    `select set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify({ sub: volunteerId, role: "service_role" })],
  );

  const reqId = randomUUID();
  await client.query(
    `select * from public.register_patient_idempotent(
       p_request_id => $1,
       p_camp_id => $2,
       p_full_name => 'Locked Patient',
       p_gender => 'M',
       p_age => 45,
       p_address => 'Jaipur',
       p_phone => '9888888888',
       p_email => null,
       p_aadhaar_last4 => '5555',
       p_user_id => null,
       p_created_by => $3,
       p_camp_day_id => $4,
       p_aadhaar_duplicate_override => false,
       p_likely_duplicate_override => false,
       p_self_service => false,
       p_provenance => 'card_verified',
       p_duplicate_key => $5,
       p_date_of_birth => '1981-04-12'::date
     )`,
    [reqId, campId, volunteerId, dayId, dupKey],
  );

  await client.query("reset role");

  const { rows: personRows } = await client.query(
    `select * from public.persons where duplicate_key = $1`,
    [dupKey],
  );

  assert.equal(personRows.length, 1);
  assert.ok(personRows[0].aadhaar_locked_at, "aadhaar_locked_at is set");
  assert.ok(personRows[0].name_locked_at, "name_locked_at is set");

  const personId = personRows[0].id;

  // Unlocked fields (address, phone) can be updated
  await client.query(
    `update public.persons set address = 'Updated Address' where id = $1`,
    [personId],
  );

  // Modifying locked aadhaar_last4 throws exception
  await client.query("savepoint before_aadhaar_update");
  await assert.rejects(
    async () => {
      await client.query(
        `update public.persons set aadhaar_last4 = '9999' where id = $1`,
        [personId],
      );
    },
    (err) => {
      return err.message.includes("Aadhaar field is locked");
    },
  );
  await client.query("rollback to savepoint before_aadhaar_update");
  await client.query("release savepoint before_aadhaar_update");

  // Modifying locked full_name throws exception
  await client.query("savepoint before_name_update");
  await assert.rejects(
    async () => {
      await client.query(
        `update public.persons set full_name = 'Changed Name' where id = $1`,
        [personId],
      );
    },
    (err) => {
      return err.message.includes("Name field is locked");
    },
  );
  await client.query("rollback to savepoint before_name_update");
  await client.query("release savepoint before_name_update");

  for (const [column, value, message] of [
    ["date_of_birth", "'1982-04-12'::date", "Date of birth field is locked"],
    ["gender", "'F'::text", "Gender field is locked"],
  ]) {
    const savepoint = `before_${column}_update`;
    await client.query(`savepoint ${savepoint}`);
    await assert.rejects(
      () =>
        client.query(
          `update public.persons set ${column} = ${value} where id = $1`,
          [personId],
        ),
      (err) => err.message.includes(message),
    );
    await client.query(`rollback to savepoint ${savepoint}`);
    await client.query(`release savepoint ${savepoint}`);
  }

  await client.query("rollback");
});
