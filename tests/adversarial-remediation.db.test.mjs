/**
 * DB proofs for 2026-07-31 adversarial remediation:
 * - Seat caps: desk walk-in on today (Asia/Kolkata) allowed when full;
 *   self-service and future-day pre-reg still blocked.
 * - register_manual_exception returns a narrow projection (no status_token).
 *
 * Requires local Supabase Postgres (default 127.0.0.1:54322) with migration
 * 20260731090000_adversarial_deep_review_remediation applied.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { createHash, randomUUID } from "node:crypto";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

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
      "[adversarial-remediation.db] local Postgres unavailable — DB tests skipped",
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

async function todayInKolkata() {
  const { rows } = await client.query(
    `select (timezone('Asia/Kolkata', now()))::date::text as day`,
  );
  return rows[0].day;
}

async function seedCampWithDay(dayDate, seatLimit = 1) {
  const campId = randomUUID();
  const dayId = randomUUID();
  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock(918273777)");
    await client.query(
      `update public.camps set is_active = false where is_active = true`,
    );
    await client.query(
      `insert into public.camps (id, name, is_active, venue)
       values ($1, $2, true, 'adv-remediation')`,
      [campId, `Adv rem camp ${campId.slice(0, 8)}`],
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
  await client.query(`delete from public.patients where camp_id = $1`, [campId]);
  await client.query(`delete from public.camp_days where camp_id = $1`, [campId]);
  await client.query(`delete from public.camps where id = $1`, [campId]);
}

/**
 * @param {'admin'|'team_lead'|'volunteer'} role
 */
async function seedStaff(role = "volunteer") {
  const userId = randomUUID();
  const email = `adv-${role}-${userId.slice(0, 8)}@test.local`;
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
     values ($1, $2, $3, $4)
     on conflict (id) do update set role = excluded.role, disabled_at = null`,
    [userId, role, `Adv ${role}`, email],
  );
  return userId;
}

async function cleanupStaff(userId) {
  await client.query(
    `update public.patients set
       created_by = null,
       manual_exception_actor = null,
       aadhaar_duplicate_override_by = null,
       likely_duplicate_override_by = null
     where created_by = $1
        or manual_exception_actor = $1
        or aadhaar_duplicate_override_by = $1
        or likely_duplicate_override_by = $1`,
    [userId],
  );
  await client.query(`delete from public.profiles where id = $1`, [userId]);
  await client.query(`delete from auth.users where id = $1`, [userId]);
}

async function seedPatients(campId, dayId, n) {
  for (let i = 0; i < n; i++) {
    await client.query(
      `insert into public.patients (camp_id, camp_day_id, full_name, queue_status)
       values ($1, $2, $3, 'registered')`,
      [campId, dayId, `Seed Full ${i + 1}`],
    );
  }
}

/**
 * @param {object} args
 */
async function registerPatient(args) {
  const {
    requestId = randomUUID(),
    campId,
    dayId,
    fullName = "Walk In Patient",
    age = 42,
    phone = "9876501234",
    createdBy = null,
    selfService = false,
    provenance = selfService ? "card_scanned" : "self_declared",
    aadhaarLast4 = selfService ? "4321" : null,
    identityHash = selfService ? `hmac-adv-${randomUUID()}` : null,
  } = args;

  const duplicateKey = identityHash
    ? createHash("sha256").update(identityHash).digest("hex")
    : null;

  await client.query("begin");
  try {
    await client.query(
      `select set_config('request.jwt.claim.role', 'service_role', true)`,
    );
    const { rows } = await client.query(
      `select id, reg_no, full_name, camp_day_id, day_date, queue_status
       from public.register_patient_idempotent(
         $1::uuid, $2::uuid, $3::text, 'M', $4::integer, 'Test address',
         $5::text, null, $10::text, null, $6::uuid, $7::uuid,
         false, false, $8::boolean, $9::text,
         $11::text, '1986-01-01'::date, null::text
       )`,
      [
        requestId,
        campId,
        fullName,
        age,
        phone,
        createdBy,
        dayId,
        selfService,
        provenance,
        aadhaarLast4,
        duplicateKey,
      ],
    );
    await client.query("commit");
    return { ok: true, row: rows[0], columns: Object.keys(rows[0] || {}) };
  } catch (err) {
    await client.query("rollback");
    return { ok: false, message: String(err.message || err) };
  }
}

test("desk walk-in on full today is allowed; self-service still blocked", async (t) => {
  if (skipIfNoDb(t)) return;

  const today = await todayInKolkata();
  const staffId = await seedStaff("volunteer");
  const { campId, dayId } = await seedCampWithDay(today, 1);
  await seedPatients(campId, dayId, 1);

  try {
    const desk = await registerPatient({
      campId,
      dayId,
      fullName: "Desk Walk In Over Cap",
      createdBy: staffId,
      selfService: false,
      phone: "9876501001",
    });
    assert.equal(desk.ok, true, desk.message);
    assert.ok(desk.row?.reg_no, "desk walk-in must receive reg_no when day is full");

    const self = await registerPatient({
      campId,
      dayId,
      fullName: "Self Service Over Cap",
      createdBy: null,
      selfService: true,
      phone: "9876501002",
    });
    assert.equal(self.ok, false, "self-service must still hit seat cap on full today");
    assert.match(self.message || "", /full|seat/i, self.message);
  } finally {
    await cleanupCamp(campId);
    await cleanupStaff(staffId);
  }
});

test("future full day still rejects desk pre-registration", async (t) => {
  if (skipIfNoDb(t)) return;

  const staffId = await seedStaff("volunteer");
  const { campId, dayId } = await seedCampWithDay("2099-12-15", 1);
  await seedPatients(campId, dayId, 1);

  try {
    const result = await registerPatient({
      campId,
      dayId,
      fullName: "Future Pre Reg Over Cap",
      createdBy: staffId,
      selfService: false,
      phone: "9876501003",
    });
    assert.equal(result.ok, false, "future-day pre-reg must respect seat_limit");
    assert.match(result.message || "", /full|seat/i, result.message);
  } finally {
    await cleanupCamp(campId);
    await cleanupStaff(staffId);
  }
});

test("register_manual_exception returns narrow projection without status_token", async (t) => {
  if (skipIfNoDb(t)) return;

  const today = await todayInKolkata();
  const actorId = await seedStaff("team_lead");
  const { campId, dayId } = await seedCampWithDay(today, 20);

  try {
    // Catalog-level: return type must not be SETOF patients (which includes status_token).
    const { rows: ret } = await client.query(
      `select pg_get_function_result(p.oid) as ret
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'register_manual_exception'`,
    );
    assert.ok(ret[0]?.ret, "function must exist");
    assert.doesNotMatch(
      ret[0].ret,
      /SETOF\s+patients/i,
      `manual exception must not return SETOF patients, got: ${ret[0].ret}`,
    );
    assert.doesNotMatch(
      ret[0].ret,
      /status_token/i,
      `return type must not mention status_token: ${ret[0].ret}`,
    );

    await client.query("begin");
    let row;
    let columns;
    try {
      await client.query(
        `select set_config('request.jwt.claim.role', 'service_role', true)`,
      );
      const result = await client.query(
        `select * from public.register_manual_exception(
           $1::uuid, $2::uuid, $3::uuid,
           'Manual Exception Patient', 'Manual Ex',
           'M', 55, 'Manual address', '9876501999',
           'scanner failed thrice in field', 3, $4::uuid
         )`,
        [randomUUID(), campId, dayId, actorId],
      );
      row = result.rows[0];
      columns = result.fields.map((f) => f.name);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    }

    assert.ok(row?.id, "manual exception must return patient id");
    assert.ok(row?.reg_no, "manual exception must return reg_no");
    assert.equal(row.full_name, "Manual Exception Patient");
    assert.equal(row.camp_day_id, dayId);
    assert.ok(row.day_date, "must return day_date");
    assert.ok(row.queue_status, "must return queue_status");

    assert.ok(!columns.includes("status_token"), `got columns: ${columns.join(",")}`);
    assert.deepEqual(
      columns.sort(),
      ["camp_day_id", "day_date", "full_name", "id", "queue_status", "reg_no"].sort(),
    );

    // Token still exists on the row in DB, just must not appear in RPC payload.
    const { rows: stored } = await client.query(
      `select status_token is not null as has_token, provenance, manual_exception_actor
       from public.patients where id = $1`,
      [row.id],
    );
    assert.equal(stored[0].has_token, true);
    assert.equal(stored[0].provenance, "manual_exception");
    assert.equal(stored[0].manual_exception_actor, actorId);
  } finally {
    await cleanupCamp(campId);
    await cleanupStaff(actorId);
  }
});


test("exactly one register_patient_idempotent and no register_patient_v2", async (t) => {
  if (skipIfNoDb(t)) return;
  const { rows } = await client.query(`
    select
      (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'register_patient_idempotent') as reg_count,
      (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'register_patient_v2') as v2_count,
      to_regprocedure(
        'public.register_patient_v2(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean,text)'
      ) is null as v2_sig_gone
  `);
  assert.equal(rows[0].reg_count, 1);
  assert.equal(rows[0].v2_count, 0);
  assert.equal(rows[0].v2_sig_gone, true);
});

test("SMS eligibility routines no longer contain card_verified", async (t) => {
  if (skipIfNoDb(t)) return;
  const { rows } = await client.query(`
    select p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'claim_sms_delivery',
        'patient_registration_notify_fields',
        'reject_self_registration_delivery'
      )
      and pg_get_functiondef(p.oid) like '%card_verified%'
  `);
  assert.equal(rows.length, 0);
});
