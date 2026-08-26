import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const VENUE = "aadhaar-confirm-test";

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
      "[aadhaar-confirmation.db] local Postgres unavailable — DB tests skipped",
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
    [userId, `confirm-${role}-${userId.slice(0, 8)}@example.test`],
  );
  await client.query(
    `insert into public.profiles (id, role, full_name, email)
     values ($1, $2, $3, $4)
     on conflict (id) do update set role = $2, disabled_at = null`,
    [
      userId,
      role,
      `Confirm ${role}`,
      `confirm-${role}-${userId.slice(0, 8)}@example.test`,
    ],
  );
  return userId;
}

async function seedCamp() {
  const campId = randomUUID();
  const dayId = randomUUID();
  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock(918273648)");
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
      [campId, `Confirm ${campId.slice(0, 8)}`, VENUE],
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

async function registerManualException(campId, dayId, actorId, name) {
  return asServiceRole(async () => {
    const { rows } = await client.query(
      `select * from public.register_manual_exception(
         $1::uuid, $2::uuid, $3::uuid, $4, 'Latin Name', 'M', 55,
         'Typed address', '9876501999', 'card worn through', 2, $5::uuid)`,
      [randomUUID(), campId, dayId, name, actorId],
    );
    return rows[0];
  });
}

async function confirm(args) {
  return asServiceRole(async () => {
    const { rows } = await client.query(
      `select * from public.confirm_manual_exception_aadhaar(
         $1, $2, $3, $4, $5::date, $6, $7, $8, false, $9, $10)`,
      args,
    );
    return rows[0];
  });
}

test("a manual exception starts with a null Person key", async (t) => {
  if (skipIfNoDb(t)) return;
  const actorId = await seedProfile("volunteer");
  const { campId, dayId } = await seedCamp();
  const patient = await registerManualException(
    campId,
    dayId,
    actorId,
    "Needs Confirmation",
  );

  const { rows } = await client.query(
    `select p.provenance, p.failed_scan_attempts, pe.duplicate_key
       from public.patients p
       join public.persons pe on pe.id = p.person_id
      where p.id = $1`,
    [patient.id],
  );
  assert.equal(rows[0].provenance, "manual_exception");
  assert.equal(rows[0].failed_scan_attempts, 2);
  assert.equal(rows[0].duplicate_key, null);
});

test("inspect reports a free key and mutates nothing", async (t) => {
  if (skipIfNoDb(t)) return;
  const actorId = await seedProfile("volunteer");
  const { campId, dayId } = await seedCamp();
  const patient = await registerManualException(
    campId,
    dayId,
    actorId,
    "Inspect Only",
  );
  const key = `inspect-${randomUUID()}`;

  const row = await confirm([
    patient.id,
    "inspect",
    key,
    "Card Name",
    "1971-03-04",
    "M",
    "4321",
    "Card address",
    actorId,
    null,
  ]);
  assert.equal(row.outcome, "free");

  const { rows } = await client.query(
    `select pe.duplicate_key, pe.full_name, pe.aadhaar_locked_at
       from public.patients p
       join public.persons pe on pe.id = p.person_id
      where p.id = $1`,
    [patient.id],
  );
  assert.equal(rows[0].duplicate_key, null, "inspect must not attach the key");
  assert.equal(rows[0].full_name, "Inspect Only");
  assert.equal(rows[0].aadhaar_locked_at, null);
});

test("commit attaches a free key, overwrites identity, and locks the fields", async (t) => {
  if (skipIfNoDb(t)) return;
  const actorId = await seedProfile("volunteer");
  const { campId, dayId } = await seedCamp();
  const patient = await registerManualException(
    campId,
    dayId,
    actorId,
    "Commit Me",
  );
  const key = `commit-${randomUUID()}`;

  const { rows: before } = await client.query(
    `select pe.display_name
       from public.patients p
       join public.persons pe on pe.id = p.person_id
      where p.id = $1`,
    [patient.id],
  );

  const row = await confirm([
    patient.id,
    "commit",
    key,
    "Card Name",
    "1971-03-04",
    "F",
    "4321",
    "Card address",
    actorId,
    null,
  ]);
  assert.equal(row.outcome, "committed");

  const { rows } = await client.query(
    `select pe.duplicate_key, pe.full_name, pe.gender, pe.aadhaar_last4,
            pe.address, pe.display_name,
            pe.aadhaar_locked_at is not null as aadhaar_locked,
            pe.address_locked_at is not null as address_locked,
            pe.confirmation_replaced is not null as retained_pre_overwrite
       from public.patients p
       join public.persons pe on pe.id = p.person_id
      where p.id = $1`,
    [patient.id],
  );
  assert.equal(rows[0].duplicate_key, key);
  assert.equal(rows[0].full_name, "Card Name");
  assert.equal(rows[0].gender, "F");
  assert.equal(rows[0].aadhaar_last4, "4321");
  assert.equal(rows[0].address, "Card address");
  assert.equal(
    rows[0].display_name,
    before[0].display_name,
    "the Latin display name typed at manual registration survives the card overwrite",
  );
  assert.equal(rows[0].aadhaar_locked, true);
  assert.equal(rows[0].address_locked, true);
  assert.equal(rows[0].retained_pre_overwrite, true);
});

test("a second patient committing the same card is refused by name", async (t) => {
  if (skipIfNoDb(t)) return;
  const actorId = await seedProfile("volunteer");
  const { campId, dayId } = await seedCamp();
  const first = await registerManualException(campId, dayId, actorId, "Key Owner");
  const second = await registerManualException(campId, dayId, actorId, "Key Rival");
  const key = `taken-${randomUUID()}`;

  await confirm([
    first.id,
    "commit",
    key,
    "Owner Card",
    "1971-03-04",
    "M",
    "4321",
    "Owner address",
    actorId,
    null,
  ]);

  const inspected = await confirm([
    second.id,
    "inspect",
    key,
    "Owner Card",
    "1971-03-04",
    "M",
    "4321",
    "Owner address",
    actorId,
    null,
  ]);
  assert.equal(inspected.outcome, "collision");
  assert.ok(Number(inspected.surviving_reg_no) > 0);
});

test("normal and already-confirmed registrations return minimal not_required", async (t) => {
  if (skipIfNoDb(t)) return;
  const actorId = await seedProfile("volunteer");
  const { campId, dayId } = await seedCamp();
  const scanned = await asServiceRole(async () => {
    const { rows } = await client.query(
      `select * from public.register_patient_idempotent(
         $1, $2, 'Normal Patient', 'M', 40, 'Ward 1', null, null, null,
         null, $3, $4, false, false, false, 'self_declared', null, null, null)`,
      [randomUUID(), campId, actorId, dayId],
    );
    return rows[0];
  });
  const row = await confirm([
    scanned.id,
    "inspect",
    null,
    null,
    null,
    null,
    null,
    null,
    actorId,
    null,
  ]);
  assert.equal(row.outcome, "not_required");
  assert.equal(row.typed_date_of_birth, null);
  assert.equal(row.typed_aadhaar_last4, null);
  assert.equal(row.typed_address, null);
  assert.equal(row.surviving_name, null);
});

test("inactive and missing registrations are denied", async (t) => {
  if (skipIfNoDb(t)) return;
  const actorId = await seedProfile("volunteer");
  const { campId, dayId } = await seedCamp();
  const patient = await registerManualException(
    campId,
    dayId,
    actorId,
    "Inactive Confirm",
  );
  await client.query(`update public.camps set is_active = false where id = $1`, [
    campId,
  ]);
  await assert.rejects(
    () =>
      confirm([
        patient.id,
        "inspect",
        `k-${randomUUID()}`,
        "Card",
        "1971-03-04",
        "M",
        "4321",
        "Addr",
        actorId,
        null,
      ]),
    /inactive camp/i,
  );
  await assert.rejects(
    () =>
      confirm([
        randomUUID(),
        "inspect",
        null,
        null,
        null,
        null,
        null,
        null,
        actorId,
        null,
      ]),
    /Patient not found/,
  );
});

test("a volunteer cannot override confirmation; a team lead can", async (t) => {
  if (skipIfNoDb(t)) return;
  const volunteerId = await seedProfile("volunteer");
  const leadId = await seedProfile("team_lead");
  const { campId, dayId } = await seedCamp();
  const patient = await registerManualException(
    campId,
    dayId,
    volunteerId,
    "Override Me",
  );

  await assert.rejects(
    () =>
      confirm([
        patient.id,
        "override",
        null,
        null,
        null,
        null,
        null,
        null,
        volunteerId,
        "card will not scan",
      ]),
    /VOLUNTEER_OVERRIDE_FORBIDDEN/,
  );

  const row = await confirm([
    patient.id,
    "override",
    null,
    null,
    null,
    null,
    null,
    null,
    leadId,
    "card will not scan",
  ]);
  assert.equal(row.outcome, "overridden");

  const { rows } = await client.query(
    `select confirmation_override_actor, confirmation_override_reason
       from public.patients where id = $1`,
    [patient.id],
  );
  assert.equal(rows[0].confirmation_override_actor, leadId);
  assert.equal(rows[0].confirmation_override_reason, "card will not scan");
});
