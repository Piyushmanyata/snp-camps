/**
 * Ticket #93 — Counter Desk DB test suite.
 * Verifies resolve_treatment_order RPC, role checks, double fulfillment prevention,
 * and derived patient completion (seen + 0 pending orders).
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const VENUE = "counter-test-venue";

/** @type {pg.Client | null} */
let client = null;
let dbAvailable = false;

async function connect() {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await c.connect();
    const { rows } = await c.query(
      `select to_regclass('public.treatment_orders') is not null as ok`,
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
      "[counter-desk.db] local Postgres unavailable — DB tests skipped",
    );
  }
});

test.after(async () => {
  if (client) {
    try {
      await client.query(
        `delete from public.treatment_orders where camp_id in (
           select id from public.camps where venue = $1
         )`,
        [VENUE],
      );
      await client.query(
        `delete from public.prescriptions where camp_id in (
           select id from public.camps where venue = $1
         )`,
        [VENUE],
      );
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
        `delete from public.profiles where email like '%@counter.test'`,
      );
      await client.query(
        `delete from auth.users where email like '%@counter.test'`,
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
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ role: "authenticated", sub: userId }),
    ]);
    await client.query(`set local role authenticated`);
    const result = await fn();
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

async function asAnon(fn) {
  await client.query("begin");
  try {
    await client.query(
      `select set_config('request.jwt.claim.role', 'anon', true)`,
    );
    await client.query(`set local role anon`);
    const result = await fn();
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

async function createTestUser(email, role) {
  const userId = randomUUID();
  await client.query(
    `insert into auth.users (id, email) values ($1, $2)`,
    [userId, email],
  );
  await client.query(
    `insert into public.profiles (id, email, role, full_name) values ($1, $2, $3, $4)`,
    [userId, email, role, `Test User ${role}`],
  );
  return userId;
}

async function createTestCamp() {
  const campId = randomUUID();
  const dayId = randomUUID();
  await client.query(
    `insert into public.camps (
       id, name, venue, is_active,
       spectacles_collection_date, spectacles_collection_venue,
       post_camp_surgery_date, post_camp_surgery_venue
     ) values ($1, $2, $3, false, '2026-10-15', 'Counter Spec Venue', '2026-11-20', 'Counter OT Hospital')`,
    [campId, "Counter Test Camp", VENUE],
  );
  await client.query(
    `insert into public.camp_days (id, camp_id, day_date, seat_limit) values ($1, $2, '2026-09-30', 100)`,
    [dayId, campId],
  );
  return { campId, dayId };
}

async function createTestPatient(campId, dayId, status = "waiting") {
  const patientId = randomUUID();
  const reqId = randomUUID();
  await client.query(
    `insert into public.patients (
      id, registration_request_id, camp_id, camp_day_id, full_name, queue_status, queued_at
    ) values ($1, $2, $3, $4, $5, $6::public.queue_status, case when $6 = 'waiting' then now() else null end)`,
    [patientId, reqId, campId, dayId, "Counter Patient", status],
  );
  return patientId;
}

function formatDate(val) {
  if (!val) return "";
  if (typeof val === "string") return val.slice(0, 10);
  if (val instanceof Date) {
    const yyyy = val.getFullYear();
    const mm = String(val.getMonth() + 1).padStart(2, "0");
    const dd = String(val.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  return String(val).slice(0, 10);
}

test("resolve_treatment_order RPC: rejects non-camp-crew caller (anon)", async (t) => {
  if (skipIfNoDb(t)) return;

  const fakeOrderId = randomUUID();

  await assert.rejects(
    async () => {
      await asAnon(async () => {
        await client.query(
          `select * from public.resolve_treatment_order($1, $2)`,
          [fakeOrderId, "fulfilled"],
        );
      });
    },
    (err) => err.code === "42501" || err.message.includes("permission denied") || err.message.includes("active camp crew required"),
  );
});

test("resolve_treatment_order RPC: fulfills, defers, and cancels orders for a patient", async (t) => {
  if (skipIfNoDb(t)) return;

  const doctorId = await asServiceRole(() =>
    createTestUser(`doc_${randomUUID()}@counter.test`, "doctor"),
  );
  const staffId = await asServiceRole(() =>
    createTestUser(`vol_${randomUUID()}@counter.test`, "volunteer"),
  );
  const { campId, dayId } = await asServiceRole(() => createTestCamp());
  const patientId = await asServiceRole(() =>
    createTestPatient(campId, dayId, "waiting"),
  );

  // 1. Doctor submits prescription creating 3 orders: pharmacy, spectacles, ot
  const submitRes = await asAuthenticated(doctorId, async () => {
    const { rows } = await client.query(
      `select * from public.doctor_submit_prescription($1, $2, $3, $4, $5, $6, $7)`,
      [
        patientId,
        "Cataract & Refractive Error",
        "RE: 6/18, LE: 6/24",
        "Antibiotic Eye Drops",
        "Spectacles & Surgery needed",
        "fixed",
        ["pharmacy", "spectacles", "ot"],
      ],
    );
    return rows[0];
  });

  assert.equal(submitRes.queue_status, "seen");
  assert.equal(submitRes.created_orders_count, 3);

  // Fetch created orders
  const orders = await asServiceRole(async () => {
    const { rows } = await client.query(
      `select id, kind, status from public.treatment_orders where patient_id = $1 order by kind`,
      [patientId],
    );
    return rows;
  });

  const pharmacyOrder = orders.find((o) => o.kind === "pharmacy");
  const spectaclesOrder = orders.find((o) => o.kind === "spectacles");
  const otOrder = orders.find((o) => o.kind === "ot");

  assert.ok(pharmacyOrder);
  assert.ok(spectaclesOrder);
  assert.ok(otOrder);

  // 2. Staff fulfills Pharmacy order
  const fulfillRes = await asAuthenticated(staffId, async () => {
    const { rows } = await client.query(
      `select * from public.resolve_treatment_order($1, $2)`,
      [pharmacyOrder.id, "fulfilled"],
    );
    return rows[0];
  });

  assert.equal(fulfillRes.status, "fulfilled");
  assert.equal(fulfillRes.closed_by, staffId);
  assert.ok(fulfillRes.closed_at);

  // 3. Staff defers Spectacles order with date and venue
  const deferRes = await asAuthenticated(staffId, async () => {
    const { rows } = await client.query(
      `select * from public.resolve_treatment_order($1, $2, $3, $4)`,
      [spectaclesOrder.id, "deferred", "2026-10-15", "Base Hospital"],
    );
    return rows[0];
  });

  assert.equal(deferRes.status, "deferred");
  assert.equal(deferRes.closed_by, staffId);
  assert.equal(formatDate(deferRes.deferred_date), "2026-10-15");
  assert.equal(deferRes.deferred_venue, "Base Hospital");

  // 4. Staff cancels OT order
  const cancelRes = await asAuthenticated(staffId, async () => {
    const { rows } = await client.query(
      `select * from public.resolve_treatment_order($1, $2)`,
      [otOrder.id, "cancelled"],
    );
    return rows[0];
  });

  assert.equal(cancelRes.status, "cancelled");
  assert.equal(cancelRes.closed_by, staffId);

  // 5. Verify Derived Completion:
  // Patient queue_status remains 'seen' (never altered to a non-existent enum value)
  const patientRow = await asServiceRole(async () => {
    const { rows } = await client.query(
      `select queue_status from public.patients where id = $1`,
      [patientId],
    );
    return rows[0];
  });
  assert.equal(patientRow.queue_status, "seen");

  // Count remaining pending treatment orders for patient
  const pendingOrdersCount = await asServiceRole(async () => {
    const { rows } = await client.query(
      `select count(*)::integer as count from public.treatment_orders where patient_id = $1 and status = 'pending'`,
      [patientId],
    );
    return rows[0].count;
  });

  assert.equal(pendingOrdersCount, 0);

  const isCompletedDerived =
    patientRow.queue_status === "seen" && pendingOrdersCount === 0;
  assert.equal(isCompletedDerived, true, "Patient completion is derived");
});

test("resolve_treatment_order RPC: prevents double fulfillment", async (t) => {
  if (skipIfNoDb(t)) return;

  const doctorId = await asServiceRole(() =>
    createTestUser(`doc_${randomUUID()}@counter.test`, "doctor"),
  );
  const staffId = await asServiceRole(() =>
    createTestUser(`vol_${randomUUID()}@counter.test`, "volunteer"),
  );
  const { campId, dayId } = await asServiceRole(() => createTestCamp());
  const patientId = await asServiceRole(() =>
    createTestPatient(campId, dayId, "waiting"),
  );

  // Doctor submits prescription with 1 order
  await asAuthenticated(doctorId, async () => {
    await client.query(
      `select * from public.doctor_submit_prescription($1, $2, $3, $4, $5, $6, $7)`,
      [patientId, "Miopia", null, "Drops", null, "fixed", ["pharmacy"]],
    );
  });

  const order = await asServiceRole(async () => {
    const { rows } = await client.query(
      `select id from public.treatment_orders where patient_id = $1`,
      [patientId],
    );
    return rows[0];
  });

  // First resolution: Fulfill
  await asAuthenticated(staffId, async () => {
    await client.query(
      `select * from public.resolve_treatment_order($1, $2)`,
      [order.id, "fulfilled"],
    );
  });

  // Second attempt to fulfill same order fails
  await assert.rejects(
    async () => {
      await asAuthenticated(staffId, async () => {
        await client.query(
          `select * from public.resolve_treatment_order($1, $2)`,
          [order.id, "fulfilled"],
        );
      });
    },
    (err) => err.message.includes("Treatment order is already closed"),
  );
});
