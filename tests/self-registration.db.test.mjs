/**
 * Real-Postgres coverage for issue #79: self-service registration semantics.
 * Requires local Supabase Postgres (default 127.0.0.1:54322).
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { createHash, randomUUID } from "node:crypto";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const RPC =
  "public.register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean,boolean,text,text,date,text)";

/** @type {pg.Client | null} */
let client = null;
let dbAvailable = false;

async function connect() {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await c.connect();
    const { rows } = await c.query(
      `select to_regprocedure($1) is not null as ok`,
      [RPC],
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
      "[self-registration.db] local Postgres unavailable or #79 migration not applied — DB tests skipped",
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

async function asAuthenticated(userId, fn) {
  await client.query("begin");
  try {
    await client.query(
      `select set_config('request.jwt.claim.role', 'authenticated', true)`,
    );
    await client.query(
      `select set_config('request.jwt.claim.sub', $1, true)`,
      [userId],
    );
    const result = await fn();
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

async function todayInKolkata() {
  const { rows } = await client.query(
    `select (timezone('Asia/Kolkata', now()))::date::text as day`,
  );
  return rows[0].day;
}

async function seedCampWithDay(dayDate, seatLimit = 20) {
  const campId = randomUUID();
  const dayId = randomUUID();
  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock(918273645)");
    await client.query(
      `update public.camps set is_active = false where is_active = true`,
    );
    await client.query(
      `insert into public.camps (id, name, is_active, venue)
       values ($1, $2, true, 'self-registration-test')`,
      [campId, `Self-registration camp ${campId.slice(0, 8)}`],
    );
    await client.query(
      `insert into public.camp_days (id, camp_id, day_date, seat_limit)
       values ($1, $2, $3::date, $4)`,
      [dayId, campId, dayDate, seatLimit],
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

async function seedStaff() {
  const userId = randomUUID();
  const email = `self-registration-staff-${userId.slice(0, 8)}@test.local`;
  await client.query(
    `insert into auth.users (
       id, instance_id, aud, role, email, encrypted_password,
       email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
       created_at, updated_at
     ) values (
       $1, '00000000-0000-0000-0000-000000000000',
       'authenticated', 'authenticated', $2, crypt('unused', gen_salt('bf')),
       now(), '{"provider":"email","providers":["email"]}'::jsonb,
       '{}'::jsonb, now(), now()
     )`,
    [userId, email],
  );
  await client.query(
    `insert into public.profiles (id, role, full_name, email)
     values ($1, 'volunteer', 'Self-registration Staff', $2)`,
    [userId, email],
  );
  return userId;
}

async function cleanupStaff(userId) {
  await client.query(
    `update public.patients set created_by = null where created_by = $1`,
    [userId],
  );
  await client.query(`delete from public.profiles where id = $1`, [userId]);
  await client.query(`delete from auth.users where id = $1`, [userId]);
}

async function callSelf({
  campId,
  dayId,
  name = "Self Service Patient",
  age = 40,
  hash = "hmac-self-a",
  last4 = "9012",
  requestId = randomUUID(),
  selfService = true,
  aadhaarOverride = false,
  likelyOverride = false,
  createdBy = null,
  phone = "9876501234",
  provenance = "card_scanned",
}) {
  const duplicateKey = createHash("sha256").update(hash).digest("hex");
  await client.query("begin");
  try {
    await client.query(
      `select set_config('request.jwt.claim.role', 'service_role', true)`,
    );
    const { rows } = await client.query(
      `select id, reg_no, full_name, camp_day_id, day_date, queue_status
       from public.register_patient_idempotent(
         $1::uuid, $2::uuid, $3::text, 'M', $4::integer, 'Test address',
         $5::text, null, $6::text, null, $7::uuid, $8::uuid,
         $9::boolean, $10::boolean, $11::boolean, $13::text,
         $12::text, '1986-01-01'::date, null::text
       )`,
      [
        requestId,
        campId,
        name,
        age,
        phone,
        last4,
        createdBy,
        dayId,
        aadhaarOverride,
        likelyOverride,
        selfService,
        duplicateKey,
        provenance,
      ],
    );
    await client.query("commit");
    return { ok: true, row: rows[0] };
  } catch (err) {
    await client.query("rollback");
    return { ok: false, message: String(err.message || err) };
  }
}

test("today self-registration stays registered with provenance and no queue fields", async (t) => {
  if (skipIfNoDb(t)) return;
  const { campId, dayId } = await seedCampWithDay(await todayInKolkata());
  try {
    const result = await callSelf({ campId, dayId });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.row.queue_status, "registered");

    const { rows } = await client.query(
      `select p.queue_status, p.queued_at, p.checked_in_by, p.created_by,
              p.aadhaar_last4, p.provenance, p.phone_provenance,
              pe.duplicate_key
       from public.patients p
       join public.persons pe on pe.id = p.person_id
       where p.id = $1`,
      [result.row.id],
    );
    assert.equal(rows[0].queue_status, "registered");
    assert.equal(rows[0].queued_at, null);
    assert.equal(rows[0].checked_in_by, null);
    assert.equal(rows[0].created_by, null);
    assert.equal(rows[0].aadhaar_last4, "9012");
    assert.equal(rows[0].provenance, "card_scanned");
    assert.equal(rows[0].phone_provenance, "self_declared");
    assert.equal(
      rows[0].duplicate_key,
      createHash("sha256").update("hmac-self-a").digest("hex"),
    );

    const { rows: sms } = await client.query(
      `select count(*)::int as count
       from public.sms_deliveries
       where patient_id = $1 and kind = 'registration'`,
      [result.row.id],
    );
    assert.equal(sms[0].count, 0);
  } finally {
    await cleanupCamp(campId);
  }
});

test("self-service rejects both duplicate overrides", async (t) => {
  if (skipIfNoDb(t)) return;
  const { campId, dayId } = await seedCampWithDay("2099-11-01");
  try {
    const aadhaar = await callSelf({
      campId,
      dayId,
      hash: "hmac-override-a",
      aadhaarOverride: true,
    });
    assert.equal(aadhaar.ok, false);
    assert.match(aadhaar.message, /Aadhaar duplicate override requires staff/i);

    const likely = await callSelf({
      campId,
      dayId,
      hash: "hmac-override-b",
      likelyOverride: true,
    });
    assert.equal(likely.ok, false);
    assert.match(likely.message, /Likely-duplicate override requires staff/i);
  } finally {
    await cleanupCamp(campId);
  }
});

test("same Aadhaar replays within a camp but registers in another camp", async (t) => {
  if (skipIfNoDb(t)) return;
  const firstCamp = await seedCampWithDay("2099-12-01");
  let secondCamp;
  try {
    const first = await callSelf({
      campId: firstCamp.campId,
      dayId: firstCamp.dayId,
      hash: "hmac-cross-camp",
    });
    assert.equal(first.ok, true, first.message);

    const replay = await callSelf({
      campId: firstCamp.campId,
      dayId: firstCamp.dayId,
      name: "Different Name Same Aadhaar",
      age: 41,
      hash: "hmac-cross-camp",
      requestId: randomUUID(),
    });
    assert.equal(replay.ok, true, replay.message);
    assert.equal(replay.row.reg_no, first.row.reg_no);

    const { rows: oneCamp } = await client.query(
      `select count(*)::int as count
       from public.patients p
       join public.persons pe on pe.id = p.person_id
       where p.camp_id = $1 and pe.duplicate_key = $2`,
      [
        firstCamp.campId,
        createHash("sha256").update("hmac-cross-camp").digest("hex"),
      ],
    );
    assert.equal(oneCamp[0].count, 1);

    secondCamp = await seedCampWithDay("2099-12-02");
    const otherCamp = await callSelf({
      campId: secondCamp.campId,
      dayId: secondCamp.dayId,
      name: "Same Aadhaar Other Camp",
      age: 42,
      hash: "hmac-cross-camp",
      requestId: randomUUID(),
    });
    assert.equal(otherCamp.ok, true, otherCamp.message);
    assert.equal(
      otherCamp.row.reg_no,
      first.row.reg_no,
      "a Person keeps one permanent registration number across Camps",
    );
  } finally {
    if (secondCamp) await cleanupCamp(secondCamp.campId);
    await cleanupCamp(firstCamp.campId);
  }
});

test("null-day desk replay remains visible and one scanned Person cannot register twice in a Camp", async (t) => {
  if (skipIfNoDb(t)) return;
  const { campId, dayId } = await seedCampWithDay("2099-12-10");
  const staffId = await seedStaff();
  const requestId = randomUUID();
  const nullDayPatientId = randomUUID();
  try {
    await client.query(
      `insert into public.patients
         (id, registration_request_id, camp_id, camp_day_id, full_name, queue_status)
       values ($1, $2, $3, null, 'Null Desk Patient', 'registered')`,
      [nullDayPatientId, requestId, campId],
    );

    const { rows: replay } = await asAuthenticated(staffId, () =>
      client.query(
        `select id, camp_day_id, day_date, queue_status
         from public.register_patient_idempotent(
           $1::uuid, $2::uuid, 'Null Desk Patient'::text, null::text,
           null::integer, null::text, null::text, null::text, null::text,
           null::uuid, null::uuid, null::uuid, false::boolean, false::boolean
         )`,
        [requestId, campId],
      ),
    );
    assert.equal(replay[0].id, nullDayPatientId);
    assert.equal(replay[0].camp_day_id, null);
    assert.equal(replay[0].day_date, null);
    assert.equal(replay[0].queue_status, "registered");

    const desk = await callSelf({
      campId,
      dayId,
      name: "Verified Desk Patient",
      age: 70,
      last4: "3456",
      hash: "hmac-desk-and-self",
      selfService: false,
      createdBy: staffId,
      requestId: randomUUID(),
      phone: "9876501234",
    });
    assert.equal(desk.ok, true, desk.message);
    assert.equal(desk.row.queue_status, "registered");

    const self = await callSelf({
      campId,
      dayId,
      name: "Self Service Same Hash",
      age: 71,
      last4: "7890",
      hash: "hmac-desk-and-self",
      requestId: randomUUID(),
      phone: "9876505678",
    });
    assert.equal(self.ok, true, self.message);
    assert.equal(self.row.id, desk.row.id);
  } finally {
    await cleanupCamp(campId);
    await cleanupStaff(staffId);
  }
});

test("patient storage has no full Aadhaar field or twelve-digit value", async (t) => {
  if (skipIfNoDb(t)) return;
  const { campId, dayId } = await seedCampWithDay("2099-12-20");
  try {
    const result = await callSelf({
      campId,
      dayId,
      hash: "hmac-no-full-aadhaar",
      last4: "9012",
    });
    assert.equal(result.ok, true, result.message);

    const { rows: columns } = await client.query(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'patients'
         and column_name ilike '%aadhaar%'`,
    );
    assert.deepEqual(
      columns.map((row) => row.column_name).sort(),
      [
        "aadhaar_duplicate_override_at",
        "aadhaar_duplicate_override_by",
        "aadhaar_last4",
      ].sort(),
    );

    const { rows } = await client.query(
      `select to_jsonb(p)::text as row_json
       from public.patients p where p.id = $1`,
      [result.row.id],
    );
    assert.doesNotMatch(rows[0].row_json, /123456789012/);
  } finally {
    await cleanupCamp(campId);
  }
});

test("rollout alias stored card_scanned and final public RPC rejects card_verified", async (t) => {
  if (skipIfNoDb(t)) return;
  const { campId, dayId } = await seedCampWithDay("2099-12-21");
  const duplicateKey = createHash("sha256")
    .update("rollout-compatibility")
    .digest("hex");
  try {
    const { rows: definitions } = await client.query(
      `select pg_get_functiondef($1::regprocedure) as definition`,
      [RPC],
    );
    const strict = `v_provenance text := lower(
    btrim(coalesce(p_provenance, 'self_declared'))
  );`;
    const compatibility = `v_provenance text := CASE
    WHEN lower(btrim(coalesce(p_provenance, 'self_declared'))) = 'card_verified'
      THEN 'card_scanned'
    ELSE lower(btrim(coalesce(p_provenance, 'self_declared')))
  END;`;
    assert.match(definitions[0].definition, /requires card_scanned provenance/);
    assert.ok(definitions[0].definition.includes(strict));

    await client.query("begin");
    try {
      await client.query(
        definitions[0].definition.replace(strict, compatibility),
      );
      await client.query(
        `select set_config('request.jwt.claim.role', 'service_role', true)`,
      );
      const { rows } = await client.query(
        `select id
         from public.register_patient_idempotent(
           $1, $2, 'Rollout Patient', 'M', 40, null, '9876501234',
           null, '4321', null, null, $3, false, false, true,
           'card_verified', $4, '1986-01-01', null
         )`,
        [randomUUID(), campId, dayId, duplicateKey],
      );
      const stored = await client.query(
        `select provenance from public.patients where id = $1`,
        [rows[0].id],
      );
      assert.equal(stored.rows[0].provenance, "card_scanned");
    } finally {
      await client.query("rollback");
    }

    const rejected = await callSelf({
      campId,
      dayId,
      hash: "final-rejects-retired-input",
      provenance: "card_verified",
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.message, /requires card_scanned provenance/i);
  } finally {
    await cleanupCamp(campId);
  }
});
