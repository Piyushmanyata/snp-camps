/**
 * Real-database coverage for link_patient_phone household candidates (#18).
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
      `select to_regprocedure('public.link_patient_phone(text,uuid)') is not null as ok`,
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
      "[link-patient-phone.db] local Postgres unavailable or migration not applied — DB tests skipped",
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

/** Indian mobile (starts 6–9) unique enough for parallel/retry runs. */
function randomPhone10() {
  const n = randomUUID().replace(/\D/g, "").slice(0, 9).padEnd(9, "0");
  return `9${n}`;
}

/**
 * Insert a patient-role auth user with confirmed +91 phone for RPC checks.
 * @returns {Promise<string>} user id
 */
async function seedPatientAuth(phone10) {
  const userId = randomUUID();
  const e164 = `+91${phone10}`;
  // Clear any prior failed-run residue on this E.164 (auth.users_phone_key).
  await client.query(
    `delete from public.profiles where id in (
       select id from auth.users where phone = $1
     )`,
    [e164],
  );
  await client.query(`delete from auth.users where phone = $1`, [e164]);
  await client.query(
    `insert into auth.users (
       id, instance_id, aud, role, email, phone, phone_confirmed_at,
       encrypted_password, email_confirmed_at,
       raw_app_meta_data, raw_user_meta_data,
       created_at, updated_at
     ) values (
       $1,
       '00000000-0000-0000-0000-000000000000',
       'authenticated', 'authenticated',
       $2, $3, now(),
       crypt('test-pass-not-used', gen_salt('bf')),
       now(),
       '{"provider":"phone","providers":["phone"]}'::jsonb,
       '{}'::jsonb,
       now(), now()
     )`,
    [userId, `patient-${userId.slice(0, 8)}@test.local`, e164],
  );
  await client.query(
    `insert into public.profiles (id, role, full_name, email, phone)
     values ($1, 'patient', 'DB Test Patient', $2, $3)
     on conflict (id) do update
       set role = excluded.role, disabled_at = null, phone = excluded.phone`,
    [userId, `patient-${userId.slice(0, 8)}@test.local`, phone10],
  );
  return userId;
}

async function cleanupAuth(userId) {
  await client.query(
    `update public.patients set user_id = null where user_id = $1`,
    [userId],
  );
  await client.query(`delete from public.profiles where id = $1`, [userId]);
  await client.query(`delete from auth.users where id = $1`, [userId]);
}

async function seedCampWithDay({ dayDate = "2099-06-01" } = {}) {
  const campId = randomUUID();
  const dayId = randomUUID();
  // Only one active camp is allowed (camps_one_active). Claim the slot.
  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock(918273645)");
    await client.query(
      `update public.camps set is_active = false where is_active = true`,
    );
    await client.query(
      `insert into public.camps (id, name, is_active, venue)
       values ($1, $2, true, 'db-test')`,
      [campId, `Phone link camp ${campId.slice(0, 8)}`],
    );
    await client.query(
      `insert into public.camp_days (id, camp_id, day_date, seat_limit)
       values ($1, $2, $3::date, 200)`,
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

/** Call link_patient_phone as the given patient JWT sub. */
async function callLink(userId, phoneE164, patientId = null) {
  await client.query("begin");
  try {
    await client.query(
      `select set_config('request.jwt.claim.role', 'authenticated', true)`,
    );
    await client.query(
      `select set_config('request.jwt.claim.sub', $1, true)`,
      [userId],
    );
    const { rows } = await client.query(
      `select public.link_patient_phone($1::text, $2::uuid) as result`,
      [phoneE164, patientId],
    );
    await client.query("commit");
    return { ok: true, result: rows[0]?.result };
  } catch (err) {
    await client.query("rollback");
    return { ok: false, message: String(err.message || err) };
  }
}

test("zero matches returns no_match and links nothing", async (t) => {
  if (skipIfNoDb(t)) return;
  const phone10 = randomPhone10();
  const userId = await seedPatientAuth(phone10);
  try {
    const { ok, result } = await callLink(userId, `+91${phone10}`);
    assert.equal(ok, true);
    assert.equal(result?.status, "no_match");
  } finally {
    await cleanupAuth(userId);
  }
});

test("single unlinked match links immediately (single-path behaviour)", async (t) => {
  if (skipIfNoDb(t)) return;
  const phone10 = randomPhone10();
  const userId = await seedPatientAuth(phone10);
  const { campId, dayId } = await seedCampWithDay();
  const patientId = randomUUID();
  await client.query(
    `insert into public.patients (
       id, camp_id, camp_day_id, full_name, queue_status, phone
     ) values ($1, $2, $3, 'Solo Patient', 'registered', $4)`,
    [patientId, campId, dayId, phone10],
  );
  try {
    const first = await callLink(userId, `+91${phone10}`);
    assert.equal(first.ok, true, first.message);
    assert.equal(first.result?.status, "linked");
    assert.equal(first.result?.patient_id, patientId);

    const { rows } = await client.query(
      `select user_id from public.patients where id = $1`,
      [patientId],
    );
    assert.equal(rows[0].user_id, userId);

    // Idempotent when already linked to self via explicit id.
    const again = await callLink(userId, `+91${phone10}`, patientId);
    assert.equal(again.ok, true, again.message);
    assert.equal(again.result?.status, "linked");
  } finally {
    await cleanupCamp(campId);
    await cleanupAuth(userId);
  }
});

test("multi-match returns candidates and links nothing until choose", async (t) => {
  if (skipIfNoDb(t)) return;
  const phone10 = randomPhone10();
  const userId = await seedPatientAuth(phone10);
  const { campId, dayId } = await seedCampWithDay({ dayDate: "2099-06-15" });
  const earlyId = randomUUID();
  const lateId = randomUUID();
  const otherId = randomUUID();

  // Insert earliest first so created_at orders match ticket verification.
  await client.query(
    `insert into public.patients (
       id, camp_id, camp_day_id, full_name, queue_status, phone, created_at
     ) values
       ($1, $4, $5, 'Elder Sibling', 'registered', $6, now() - interval '2 hours'),
       ($2, $4, $5, 'Younger Sibling', 'registered', $6, now() - interval '1 hour'),
       ($3, $4, $5, 'Cousin', 'registered', $6, now())`,
    [earlyId, lateId, otherId, campId, dayId, phone10],
  );

  try {
    const multi = await callLink(userId, `+91${phone10}`);
    assert.equal(multi.ok, true, multi.message);
    assert.equal(multi.result?.status, "choose");
    assert.equal(multi.result?.ask_desk, false);
    assert.equal(multi.result?.candidates?.length, 3);

    const ids = multi.result.candidates.map((c) => c.id);
    assert.deepEqual(ids, [earlyId, lateId, otherId]);
    for (const c of multi.result.candidates) {
      assert.ok(c.reg_no != null);
      assert.ok(typeof c.full_name === "string");
      assert.equal(c.camp_day, "2099-06-15");
      assert.equal(c.phone, undefined);
      assert.equal(c.address, undefined);
    }

    const { rows: before } = await client.query(
      `select count(*)::int as n from public.patients
       where camp_id = $1 and user_id is not null`,
      [campId],
    );
    assert.equal(before[0].n, 0, "multi-match must not link anyone");

    // Wrong id (not on this phone) refused.
    const fakeId = randomUUID();
    const wrong = await callLink(userId, `+91${phone10}`, fakeId);
    assert.equal(wrong.ok, false);
    assert.match(wrong.message, /not a candidate/i);

    // Choose earliest-registered.
    const chosen = await callLink(userId, `+91${phone10}`, earlyId);
    assert.equal(chosen.ok, true, chosen.message);
    assert.equal(chosen.result?.status, "linked");
    assert.equal(chosen.result?.patient_id, earlyId);

    const { rows: linked } = await client.query(
      `select id, user_id from public.patients where camp_id = $1 and user_id is not null`,
      [campId],
    );
    assert.equal(linked.length, 1);
    assert.equal(linked[0].id, earlyId);
    assert.equal(linked[0].user_id, userId);
  } finally {
    await cleanupCamp(campId);
    await cleanupAuth(userId);
  }
});

test("naming an already-linked patient is refused", async (t) => {
  if (skipIfNoDb(t)) return;
  const phone10 = randomPhone10();
  const userId = await seedPatientAuth(phone10);
  const otherUser = await seedPatientAuth(randomPhone10());
  const { campId, dayId } = await seedCampWithDay();
  const a = randomUUID();
  const b = randomUUID();
  await client.query(
    `insert into public.patients (
       id, camp_id, camp_day_id, full_name, queue_status, phone, user_id
     ) values
       ($1, $3, $4, 'Already Linked', 'registered', $5, $6),
       ($2, $3, $4, 'Still Open', 'registered', $5, null)`,
    [a, b, campId, dayId, phone10, otherUser],
  );
  try {
    // First call sees only unlinked → single match links b (not multi).
    // Seed a second open patient so multi-path + explicit already-linked id.
    const c = randomUUID();
    await client.query(
      `insert into public.patients (
         id, camp_id, camp_day_id, full_name, queue_status, phone
       ) values ($1, $2, $3, 'Also Open', 'registered', $4)`,
      [c, campId, dayId, phone10],
    );

    const multi = await callLink(userId, `+91${phone10}`);
    assert.equal(multi.result?.status, "choose");

    const refuse = await callLink(userId, `+91${phone10}`, a);
    assert.equal(refuse.ok, false);
    assert.match(refuse.message, /already linked/i);

    const { rows } = await client.query(
      `select user_id from public.patients where id = $1`,
      [a],
    );
    assert.equal(rows[0].user_id, otherUser, "must not steal the link");
  } finally {
    await cleanupCamp(campId);
    await cleanupAuth(userId);
    await cleanupAuth(otherUser);
  }
});

test("more than ten candidates caps at 10 and sets ask_desk", async (t) => {
  if (skipIfNoDb(t)) return;
  const phone10 = randomPhone10();
  const userId = await seedPatientAuth(phone10);
  const { campId, dayId } = await seedCampWithDay();
  const ids = Array.from({ length: 12 }, () => randomUUID());
  for (let i = 0; i < ids.length; i++) {
    await client.query(
      `insert into public.patients (
         id, camp_id, camp_day_id, full_name, queue_status, phone, created_at
       ) values ($1, $2, $3, $4, 'registered', $5, now() + ($6 || ' minutes')::interval)`,
      [ids[i], campId, dayId, `Member ${i + 1}`, phone10, String(i)],
    );
  }
  try {
    const multi = await callLink(userId, `+91${phone10}`);
    assert.equal(multi.ok, true, multi.message);
    assert.equal(multi.result?.status, "choose");
    assert.equal(multi.result?.ask_desk, true);
    assert.equal(multi.result?.candidates?.length, 10);
    // First ten by created_at asc = Member 1..10
    assert.equal(multi.result.candidates[0].id, ids[0]);
    assert.equal(multi.result.candidates[9].id, ids[9]);
  } finally {
    await cleanupCamp(campId);
    await cleanupAuth(userId);
  }
});

test("catalog exposes (text,uuid) not bare (text)", async (t) => {
  if (skipIfNoDb(t)) return;
  const { rows } = await client.query(
    `select
       to_regprocedure('public.link_patient_phone(text,uuid)') is not null as new_sig,
       to_regprocedure('public.link_patient_phone(text)') is not null as old_sig,
       public.app_database_contract() as contract`,
  );
  assert.equal(rows[0].new_sig, true);
  assert.equal(rows[0].old_sig, false);
  assert.notEqual(rows[0].contract, "incomplete");
});
