/**
 * #65 — Durable SMS delivery ledger (two real DB connections).
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

const personKey = (value) =>
  createHash("sha256").update(value).digest("hex");

/** @type {pg.Client | null} */
let admin = null;
let dbAvailable = false;

async function connect() {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await c.connect();
    const { rows } = await c.query(
      `select to_regclass('public.sms_deliveries') is not null as ok`,
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
  admin = await connect();
  dbAvailable = Boolean(admin);
  if (!dbAvailable) {
    console.warn(
      "[sms-deliveries.db] local Postgres unavailable — DB tests skipped",
    );
  }
});

test.after(async () => {
  if (admin) await admin.end();
});

function skipIfNoDb(t) {
  if (!dbAvailable) {
    t.skip("local Postgres not available");
    return true;
  }
  return false;
}

function newClient() {
  return new pg.Client({ connectionString: DATABASE_URL });
}

async function asService(c, fn) {
  await c.query("begin");
  try {
    await c.query(
      `select set_config('request.jwt.claim.role', 'service_role', true)`,
    );
    const result = await fn();
    await c.query("commit");
    return result;
  } catch (err) {
    await c.query("rollback");
    throw err;
  }
}

async function seedCampDay() {
  const campId = randomUUID();
  const dayId = randomUUID();
  await admin.query("begin");
  try {
    await admin.query("select pg_advisory_xact_lock(918273648)");
    await admin.query(
      `update public.camps set is_active = false where is_active = true`,
    );
    await admin.query(
      `insert into public.camps (id, name, is_active, venue)
       values ($1, $2, true, 'sms-ledger')`,
      [campId, `SMS camp ${campId.slice(0, 8)}`],
    );
    await admin.query(
      `insert into public.camp_days (id, camp_id, day_date, seat_limit)
       values ($1, $2, '2099-11-01'::date, 50)`,
      [dayId, campId],
    );
    await admin.query("commit");
  } catch (err) {
    await admin.query("rollback");
    throw err;
  }
  return { campId, dayId };
}

async function cleanupCamp(campId) {
  await admin.query(
    `delete from public.sms_deliveries where patient_id in (
       select id from public.patients where camp_id = $1
     )`,
    [campId],
  );
  await admin.query(`delete from public.patients where camp_id = $1`, [campId]);
  await admin.query(`delete from public.camp_days where camp_id = $1`, [campId]);
  await admin.query(`delete from public.camps where id = $1`, [campId]);
}

async function seedStaff() {
  const userId = randomUUID();
  await admin.query(
    `insert into auth.users (
       id, instance_id, aud, role, email,
       encrypted_password, email_confirmed_at,
       raw_app_meta_data, raw_user_meta_data,
       created_at, updated_at
     ) values (
       $1, '00000000-0000-0000-0000-000000000000',
       'authenticated', 'authenticated', $2,
       crypt('x', gen_salt('bf')), now(),
       '{"provider":"email","providers":["email"]}'::jsonb,
       '{}'::jsonb, now(), now()
     )`,
    [userId, `sms-staff-${userId.slice(0, 8)}@test.local`],
  );
  await admin.query(
    `insert into public.profiles (id, role, full_name, email)
     values ($1, 'volunteer', 'SMS Staff', $2)
     on conflict (id) do update set role = excluded.role, disabled_at = null`,
    [userId, `sms-staff-${userId.slice(0, 8)}@test.local`],
  );
  return userId;
}

async function cleanupStaff(userId) {
  await admin.query(
    `update public.patients set created_by = null,
       aadhaar_duplicate_override_by = null,
       likely_duplicate_override_by = null
     where created_by = $1
        or aadhaar_duplicate_override_by = $1
        or likely_duplicate_override_by = $1`,
    [userId],
  );
  await admin.query(`delete from public.profiles where id = $1`, [userId]);
  await admin.query(`delete from auth.users where id = $1`, [userId]);
}

test("registration with phone enqueues pending delivery in same txn", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaff();
  const { campId, dayId } = await seedCampDay();
  try {
    await admin.query("begin");
    await admin.query(
      `select set_config('request.jwt.claim.role', 'authenticated', true)`,
    );
    await admin.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      staffId,
    ]);
    await admin.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ role: "authenticated", sub: staffId }),
    ]);
    const { rows } = await admin.query(
      `select id, reg_no from public.register_patient_idempotent(
         $1::uuid, $2::uuid, 'SMS Patient', 'M', 40, 'A', '9876501234',
         null, null, null, null, $3::uuid, false, false, false, 'self_declared', null, null, null)`,
      [randomUUID(), campId, dayId],
    );
    await admin.query("commit");
    const patientId = rows[0].id;

    const { rows: d } = await admin.query(
      `select kind, state, phone_last4 from public.sms_deliveries
       where patient_id = $1`,
      [patientId],
    );
    assert.equal(d.length, 1);
    assert.equal(d[0].kind, "registration");
    assert.equal(d[0].state, "pending");
    assert.equal(d[0].phone_last4, "1234");
  } finally {
    await cleanupCamp(campId);
    await cleanupStaff(staffId);
  }
});

test("same-day desk walk-in never creates or exposes a registration SMS", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaff();
  const { campId, dayId } = await seedCampDay();
  try {
    await admin.query(
      `update public.camp_days
       set day_date = (timezone('Asia/Kolkata', now()))::date
       where id = $1`,
      [dayId],
    );
    const { rows } = await admin.query("begin").then(async () => {
      await admin.query(
        `select set_config('request.jwt.claim.role', 'authenticated', true)`,
      );
      await admin.query(
        `select set_config('request.jwt.claim.sub', $1, true)`,
        [staffId],
      );
      await admin.query(
        `select set_config('request.jwt.claims', $1, true)`,
        [JSON.stringify({ role: "authenticated", sub: staffId })],
      );
      const result = await admin.query(
        `select id, queue_status
         from public.register_patient_idempotent(
           $1::uuid, $2::uuid, 'Same Day Patient', 'F', 44, 'A',
           '9876502468', null, null, null, null, $3::uuid, false, false, false, 'self_declared', null, null, null)`,
        [randomUUID(), campId, dayId],
      );
      await admin.query("commit");
      return result;
    });

    assert.equal(rows[0].queue_status, "waiting");
    const delivery = await admin.query(
      `select 1 from public.sms_deliveries where patient_id = $1`,
      [rows[0].id],
    );
    assert.deepEqual(delivery.rows, []);

    await admin.query("begin");
    try {
      await admin.query(
        `select set_config('request.jwt.claim.role', 'authenticated', true)`,
      );
      await admin.query(
        `select set_config('request.jwt.claim.sub', $1, true)`,
        [staffId],
      );
      await admin.query(`set local role authenticated`);
      const notify = await admin.query(
        `select * from public.patient_registration_notify_fields($1)`,
        [rows[0].id],
      );
      assert.deepEqual(notify.rows, []);
    } finally {
      await admin.query("rollback");
    }
  } finally {
    if (admin) {
      await admin.query("rollback").catch(() => {});
    }
    await cleanupCamp(campId);
    await cleanupStaff(staffId);
  }
});

test("an already-pending registration SMS becomes unclaimable on camp day", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaff();
  const { campId, dayId } = await seedCampDay();
  try {
    await admin.query("begin");
    await admin.query(
      `select set_config('request.jwt.claim.role', 'authenticated', true)`,
    );
    await admin.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      staffId,
    ]);
    await admin.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ role: "authenticated", sub: staffId }),
    ]);
    const { rows } = await admin.query(
      `select id
       from public.register_patient_idempotent(
         $1::uuid, $2::uuid, 'Pending Camp Day SMS', 'F', 44, 'A',
         '9876502468', null, null, null, null, $3::uuid, false, false, false, 'self_declared', null, null, null)`,
      [randomUUID(), campId, dayId],
    );
    await admin.query("commit");

    const patientId = rows[0].id;
    const pending = await admin.query(
      `select state
       from public.sms_deliveries
       where patient_id = $1 and kind = 'registration'`,
      [patientId],
    );
    assert.equal(pending.rows[0]?.state, "pending");

    await admin.query(
      `update public.camp_days
       set day_date = (timezone('Asia/Kolkata', now()))::date
       where id = $1`,
      [dayId],
    );

    const claim = await asService(admin, () =>
      admin.query(
        `select *
         from public.claim_sms_delivery($1, 'registration', '2468', 60)`,
        [patientId],
      ),
    );
    assert.deepEqual(
      claim.rows,
      [],
      "a pending delivery must not cross the camp-day eligibility boundary",
    );

    const after = await admin.query(
      `select state, attempt_count
       from public.sms_deliveries
       where patient_id = $1 and kind = 'registration'`,
      [patientId],
    );
    assert.equal(after.rows[0]?.state, "pending");
    assert.equal(Number(after.rows[0]?.attempt_count), 0);
  } finally {
    await cleanupCamp(campId);
    await cleanupStaff(staffId);
  }
});

test("registration without phone creates no delivery", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaff();
  const { campId, dayId } = await seedCampDay();
  try {
    await admin.query("begin");
    await admin.query(
      `select set_config('request.jwt.claim.role', 'authenticated', true)`,
    );
    await admin.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      staffId,
    ]);
    const { rows } = await admin.query(
      `select id from public.register_patient_idempotent(
         $1::uuid, $2::uuid, 'No Phone', 'M', 22, 'A', null,
         null, null, null, null, $3::uuid, false, false, false, 'self_declared', null, null, null)`,
      [randomUUID(), campId, dayId],
    );
    await admin.query("commit");
    const { rows: d } = await admin.query(
      `select 1 from public.sms_deliveries where patient_id = $1`,
      [rows[0].id],
    );
    assert.equal(d.length, 0);
  } finally {
    await cleanupCamp(campId);
    await cleanupStaff(staffId);
  }
});

test("self-registration with a typed phone never creates a registration delivery", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaff();
  const { campId, dayId } = await seedCampDay();
  try {
    const { rows } = await asService(admin, () =>
      admin.query(
        `select id
         from public.register_patient_idempotent(
           p_request_id => $1,
           p_camp_id => $2,
           p_full_name => 'Self Service Patient',
           p_gender => 'F',
           p_age => 35,
           p_address => 'A',
           p_phone => '9876505678',
           p_email => null,
           p_aadhaar_last4 => '5678',
           p_user_id => null,
           p_created_by => null,
           p_camp_day_id => $3,
           p_aadhaar_duplicate_override => false,
           p_likely_duplicate_override => false,
           p_self_service => true,
           p_provenance => 'card_scanned',
           p_duplicate_key => $4,
           p_date_of_birth => '1991-02-03'::date
         )`,
        [
          randomUUID(),
          campId,
          dayId,
          personKey(`self-sms-${randomUUID()}`),
        ],
      ),
    );

    const { rows: deliveries } = await admin.query(
      `select kind
       from public.sms_deliveries
       where patient_id = $1`,
      [rows[0].id],
    );
    assert.deepEqual(
      deliveries,
      [],
      "an unverified self-service phone must never receive a live status link",
    );

    const claim = await asService(admin, () =>
      admin.query(
        `select *
         from public.claim_sms_delivery($1, 'registration', '5678', 60)`,
        [rows[0].id],
      ),
    );
    assert.deepEqual(claim.rows, [], "the claim seam must also refuse the SMS");

    await admin.query("begin");
    try {
      await admin.query(
        `select set_config('request.jwt.claim.role', 'authenticated', true)`,
      );
      await admin.query(
        `select set_config('request.jwt.claim.sub', $1, true)`,
        [staffId],
      );
      await admin.query(
        `select set_config('request.jwt.claims', $1, true)`,
        [JSON.stringify({ role: "authenticated", sub: staffId })],
      );
      await admin.query(`set local role authenticated`);
      const notify = await admin.query(
        `select *
         from public.patient_registration_notify_fields($1)`,
        [rows[0].id],
      );
      assert.deepEqual(
        notify.rows,
        [],
        "staff notification lookup must not expose a self-registration link",
      );
    } finally {
      await admin.query("rollback");
    }
  } finally {
    await cleanupCamp(campId);
    await cleanupStaff(staffId);
  }
});

test("two connections claim same delivery: exactly one wins", async (t) => {
  if (skipIfNoDb(t)) return;
  const patientId = randomUUID();
  const campId = randomUUID();
  await admin.query(
    `insert into public.camps (id, name, is_active) values ($1, 'claim-camp', false)`,
    [campId],
  );
  await admin.query(
    `insert into public.patients (id, camp_id, full_name, queue_status, phone)
     values ($1, $2, 'Claim Race', 'registered', '9000000001')`,
    [patientId, campId],
  );
  await admin.query(
    `insert into public.sms_deliveries (patient_id, kind, state, phone_last4)
     values ($1, 'reminder', 'pending', '0001')`,
    [patientId],
  );

  const c1 = newClient();
  const c2 = newClient();
  await c1.connect();
  await c2.connect();
  try {
    const claim = async (c) => {
      try {
        return await asService(c, async () => {
          const { rows } = await c.query(
            `select delivery_id, claim_token
             from public.claim_sms_delivery($1, 'reminder', '0001', 120)`,
            [patientId],
          );
          return rows[0] || null;
        });
      } catch (err) {
        return { error: String(err.message || err) };
      }
    };

    const [a, b] = await Promise.all([claim(c1), claim(c2)]);
    const wins = [a, b].filter((r) => r && r.delivery_id);
    const losses = [a, b].filter((r) => !r || !r.delivery_id);
    assert.equal(wins.length, 1, JSON.stringify({ a, b }));
    assert.equal(losses.length, 1);

    const { rows: st } = await admin.query(
      `select state, attempt_count from public.sms_deliveries where patient_id = $1`,
      [patientId],
    );
    assert.equal(st[0].state, "sending");
    assert.equal(st[0].attempt_count, 1);
  } finally {
    await c1.end();
    await c2.end();
    await admin.query(`delete from public.sms_deliveries where patient_id = $1`, [
      patientId,
    ]);
    await admin.query(`delete from public.patients where id = $1`, [patientId]);
    await admin.query(`delete from public.camps where id = $1`, [campId]);
  }
});

test("timeout path completes as ambiguous and is not reclaimable", async (t) => {
  if (skipIfNoDb(t)) return;
  const patientId = randomUUID();
  const campId = randomUUID();
  await admin.query(
    `insert into public.camps (id, name, is_active) values ($1, 'amb-camp', false)`,
    [campId],
  );
  await admin.query(
    `insert into public.patients (id, camp_id, full_name, queue_status, phone)
     values ($1, $2, 'Ambiguous', 'registered', '9000000002')`,
    [patientId, campId],
  );

  const claim = await asService(admin, async () => {
    const { rows } = await admin.query(
      `select delivery_id, claim_token
       from public.claim_sms_delivery($1, 'reminder', '0002', 60)`,
      [patientId],
    );
    return rows[0];
  });
  assert.ok(claim.delivery_id);

  const ok = await asService(admin, async () => {
    const { rows } = await admin.query(
      `select public.complete_sms_delivery($1, $2, 'ambiguous', null, 'timeout') as ok`,
      [claim.delivery_id, claim.claim_token],
    );
    return rows[0].ok;
  });
  assert.equal(ok, true);

  const second = await asService(admin, async () => {
    const { rows } = await admin.query(
      `select delivery_id from public.claim_sms_delivery($1, 'reminder', '0002', 60)`,
      [patientId],
    );
    return rows;
  });
  assert.equal(second.length, 0, "ambiguous must not be auto-reclaimed");

  const { rows: st } = await admin.query(
    `select state, last_error, reminder_sms_sent_at
     from public.sms_deliveries d
     join public.patients p on p.id = d.patient_id
     where d.patient_id = $1`,
    [patientId],
  );
  assert.equal(st[0].state, "ambiguous");
  assert.match(st[0].last_error, /timeout/);
  // Legacy dual-write: claim set timestamp; ambiguous keeps it.
  assert.ok(st[0].reminder_sms_sent_at);

  await admin.query(`delete from public.sms_deliveries where patient_id = $1`, [
    patientId,
  ]);
  await admin.query(`delete from public.patients where id = $1`, [patientId]);
  await admin.query(`delete from public.camps where id = $1`, [campId]);
});

test("known failure is reclaimable; sent stores provider request id", async (t) => {
  if (skipIfNoDb(t)) return;
  const patientId = randomUUID();
  const campId = randomUUID();
  const staffId = await seedStaff();
  await admin.query(
    `insert into public.camps (id, name, is_active) values ($1, 'fail-camp', false)`,
    [campId],
  );
  await admin.query(
    `insert into public.patients (id, camp_id, full_name, queue_status, phone, created_by)
     values ($1, $2, 'Fail Then Send', 'registered', '9000000003', $3)`,
    [patientId, campId, staffId],
  );

  const c1 = await asService(admin, async () => {
    const { rows } = await admin.query(
      `select * from public.claim_sms_delivery($1, 'registration', '0003', 60)`,
      [patientId],
    );
    return rows[0];
  });
  await asService(admin, async () => {
    await admin.query(
      `select public.complete_sms_delivery($1, $2, 'failed', null, 'MSG91 HTTP 400')`,
      [c1.delivery_id, c1.claim_token],
    );
  });

  const c2 = await asService(admin, async () => {
    const { rows } = await admin.query(
      `select * from public.claim_sms_delivery($1, 'registration', '0003', 60)`,
      [patientId],
    );
    return rows[0];
  });
  assert.ok(c2?.delivery_id, "failed delivery must be reclaimable");

  await asService(admin, async () => {
    await admin.query(
      `select public.complete_sms_delivery($1, $2, 'sent', 'req-abc-1', null)`,
      [c2.delivery_id, c2.claim_token],
    );
  });

  const { rows } = await admin.query(
    `select state, provider_request_id, attempt_count
     from public.sms_deliveries where patient_id = $1 and kind = 'registration'`,
    [patientId],
  );
  assert.equal(rows[0].state, "sent");
  assert.equal(rows[0].provider_request_id, "req-abc-1");
  assert.ok(rows[0].attempt_count >= 2);

  const c3 = await asService(admin, async () => {
    const { rows: r } = await admin.query(
      `select * from public.claim_sms_delivery($1, 'registration', '0003', 60)`,
      [patientId],
    );
    return r;
  });
  assert.equal(c3.length, 0, "sent is terminal");

  await admin.query(`delete from public.sms_deliveries where patient_id = $1`, [
    patientId,
  ]);
  await admin.query(`delete from public.patients where id = $1`, [patientId]);
  await admin.query(`delete from public.camps where id = $1`, [campId]);
});

test("stale sending lease is reclaimable", async (t) => {
  if (skipIfNoDb(t)) return;
  const patientId = randomUUID();
  const campId = randomUUID();
  await admin.query(
    `insert into public.camps (id, name, is_active) values ($1, 'stale-camp', false)`,
    [campId],
  );
  await admin.query(
    `insert into public.patients (id, camp_id, full_name, queue_status, phone)
     values ($1, $2, 'Stale Claim', 'registered', '9000000004')`,
    [patientId, campId],
  );
  await admin.query(
    `insert into public.sms_deliveries (
       patient_id, kind, state, claim_token, claim_expires_at, attempt_count, phone_last4
     ) values (
       $1, 'reminder', 'sending', $2, now() - interval '1 minute', 1, '0004'
     )`,
    [patientId, randomUUID()],
  );

  const claim = await asService(admin, async () => {
    const { rows } = await admin.query(
      `select * from public.claim_sms_delivery($1, 'reminder', '0004', 60)`,
      [patientId],
    );
    return rows[0];
  });
  assert.ok(claim?.delivery_id, "expired sending lease must reclaim");

  await admin.query(`delete from public.sms_deliveries where patient_id = $1`, [
    patientId,
  ]);
  await admin.query(`delete from public.patients where id = $1`, [patientId]);
  await admin.query(`delete from public.camps where id = $1`, [campId]);
});

test("stale lease after dispatch began becomes ambiguous and is never reclaimed", async (t) => {
  if (skipIfNoDb(t)) return;
  const patientId = randomUUID();
  const campId = randomUUID();
  await admin.query(
    `insert into public.camps (id, name, is_active)
     values ($1, 'dispatched-stale-camp', false)`,
    [campId],
  );
  await admin.query(
    `insert into public.patients (id, camp_id, full_name, queue_status, phone)
     values ($1, $2, 'Dispatched Stale', 'registered', '9000000005')`,
    [patientId, campId],
  );
  await admin.query(
    `insert into public.sms_deliveries (
       patient_id, kind, state, claim_token, claim_expires_at,
       dispatch_started_at, attempt_count, phone_last4
     ) values (
       $1, 'reminder', 'sending', $2, now() - interval '1 minute',
       now() - interval '2 minutes', 1, '0005'
     )`,
    [patientId, randomUUID()],
  );

  const claim = await asService(admin, async () => {
    const { rows } = await admin.query(
      `select * from public.claim_sms_delivery($1, 'reminder', '0005', 60)`,
      [patientId],
    );
    return rows;
  });
  assert.deepEqual(claim, []);

  const { rows } = await admin.query(
    `select state, last_error
     from public.sms_deliveries
     where patient_id = $1`,
    [patientId],
  );
  assert.equal(rows[0].state, "ambiguous");
  assert.match(rows[0].last_error, /outcome unknown/i);

  await admin.query(`delete from public.sms_deliveries where patient_id = $1`, [
    patientId,
  ]);
  await admin.query(`delete from public.patients where id = $1`, [patientId]);
  await admin.query(`delete from public.camps where id = $1`, [campId]);
});

test("authenticated cannot select sms_deliveries table directly", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaff();
  try {
    await admin.query("begin");
    await admin.query(
      `select set_config('request.jwt.claim.role', 'authenticated', true)`,
    );
    await admin.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      staffId,
    ]);
    // Table has RLS enabled and no policies + REVOKE from authenticated.
    const { rows } = await admin.query(
      `select has_table_privilege('authenticated', 'public.sms_deliveries', 'SELECT') as can_select`,
    );
    assert.equal(rows[0].can_select, false);
    await admin.query("rollback");
  } finally {
    await cleanupStaff(staffId);
  }
});

test("ledger stores no full phone or message body columns", async (t) => {
  if (skipIfNoDb(t)) return;
  const { rows } = await admin.query(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'sms_deliveries'
     order by column_name`,
  );
  const cols = rows.map((r) => r.column_name);
  assert.ok(cols.includes("phone_last4"));
  assert.ok(!cols.includes("phone"));
  assert.ok(!cols.includes("message"));
  assert.ok(!cols.includes("body"));
  assert.ok(!cols.includes("status_token"));
  assert.ok(!cols.includes("auth_key"));
});
