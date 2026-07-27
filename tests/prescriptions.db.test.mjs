/**
 * #90 — Prescriptions & Treatment Orders DB test suite.
 * Tests doctor_submit_prescription RPC, RLS boundaries, and unique pending treatment order constraints.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const VENUE = "prescription-test-venue";

/** @type {pg.Client | null} */
let client = null;
let dbAvailable = false;

async function connect() {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await c.connect();
    const { rows } = await c.query(
      `select to_regclass('public.prescriptions') is not null as ok`,
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
      "[prescriptions.db] local Postgres unavailable — DB tests skipped",
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
        `delete from public.profiles where email like '%@prescription.test'`,
      );
      await client.query(
        `delete from auth.users where email like '%@prescription.test'`,
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
    `insert into public.camps (id, name, venue, is_active) values ($1, $2, $3, false)`,
    [campId, "Prescription Test Camp", VENUE],
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
    [patientId, reqId, campId, dayId, "Test Patient", status],
  );
  return patientId;
}

test("doctor_submit_prescription RPC: doctor submits prescription with treatment orders for waiting patient", async (t) => {
  if (skipIfNoDb(t)) return;

  const doctorId = await asServiceRole(() =>
    createTestUser(`doc_${randomUUID()}@prescription.test`, "doctor"),
  );
  const { campId, dayId } = await asServiceRole(() => createTestCamp());
  const patientId = await asServiceRole(() =>
    createTestPatient(campId, dayId, "waiting"),
  );

  const res = await asAuthenticated(doctorId, async () => {
    const { rows } = await client.query(
      `select * from public.doctor_submit_prescription($1, $2, $3, $4, $5, $6, $7)`,
      [
        patientId,
        "Cactaract",
        "RE: 6/18, LE: 6/24",
        "Eye drops",
        "Surgery scheduled",
        "bifocal",
        ["ot", "pharmacy", "spectacles"],
      ],
    );
    return rows[0];
  });

  assert.ok(res);
  assert.equal(res.queue_status, "seen");
  assert.equal(res.created_orders_count, 3);

  // Verify patient is now seen
  const { rows: patientRows } = await client.query(
    `select queue_status, seen_by from public.patients where id = $1`,
    [patientId],
  );
  assert.equal(patientRows[0].queue_status, "seen");
  assert.equal(patientRows[0].seen_by, doctorId);

  // Verify prescription details
  const { rows: pRows } = await client.query(
    `select * from public.prescriptions where patient_id = $1`,
    [patientId],
  );
  assert.equal(pRows.length, 1);
  assert.equal(pRows[0].diagnosis, "Cactaract");
  assert.equal(pRows[0].spectacles_type, "bifocal");
  assert.equal(pRows[0].doctor_id, doctorId);

  // Verify treatment orders created
  const { rows: tRows } = await client.query(
    `select kind, status from public.treatment_orders where prescription_id = $1 order by kind`,
    [pRows[0].id],
  );
  assert.equal(tRows.length, 3);
  assert.deepEqual(
    tRows.map((r) => r.kind),
    ["ot", "pharmacy", "spectacles"],
  );
  assert.ok(tRows.every((r) => r.status === "pending"));
});

test("doctor_submit_prescription RPC: one-tap submit for healthy patient with 0 destinations", async (t) => {
  if (skipIfNoDb(t)) return;

  const doctorId = await asServiceRole(() =>
    createTestUser(`doc_${randomUUID()}@prescription.test`, "doctor"),
  );
  const { campId, dayId } = await asServiceRole(() => createTestCamp());
  const patientId = await asServiceRole(() =>
    createTestPatient(campId, dayId, "waiting"),
  );

  const res = await asAuthenticated(doctorId, async () => {
    const { rows } = await client.query(
      `select * from public.doctor_submit_prescription($1, $2, $3, $4, $5, $6, $7)`,
      [patientId, "Normal vision", "RE 6/6 LE 6/6", null, "Routine check", null, []],
    );
    return rows[0];
  });

  assert.ok(res);
  assert.equal(res.queue_status, "seen");
  assert.equal(res.created_orders_count, 0);

  // Verify 0 treatment orders created
  const { rows: tRows } = await client.query(
    `select * from public.treatment_orders where patient_id = $1`,
    [patientId],
  );
  assert.equal(tRows.length, 0);
});

test("doctor_submit_prescription RPC: fails if patient is in registered status", async (t) => {
  if (skipIfNoDb(t)) return;

  const doctorId = await asServiceRole(() =>
    createTestUser(`doc_${randomUUID()}@prescription.test`, "doctor"),
  );
  const { campId, dayId } = await asServiceRole(() => createTestCamp());
  const patientId = await asServiceRole(() =>
    createTestPatient(campId, dayId, "registered"),
  );

  await assert.rejects(
    async () => {
      await asAuthenticated(doctorId, async () => {
        await client.query(
          `select * from public.doctor_submit_prescription($1, $2, $3, $4, $5, $6, $7)`,
          [patientId, "Check", null, null, null, null, []],
        );
      });
    },
    (err) => err.message.includes("Patient must be in waiting or seen state"),
  );
});

test("doctor_submit_prescription RPC: rejects non-doctor/admin caller", async (t) => {
  if (skipIfNoDb(t)) return;

  const volId = await asServiceRole(() =>
    createTestUser(`vol_${randomUUID()}@prescription.test`, "volunteer"),
  );
  const { campId, dayId } = await asServiceRole(() => createTestCamp());
  const patientId = await asServiceRole(() =>
    createTestPatient(campId, dayId, "waiting"),
  );

  await assert.rejects(
    async () => {
      await asAuthenticated(volId, async () => {
        await client.query(
          `select * from public.doctor_submit_prescription($1, $2, $3, $4, $5, $6, $7)`,
          [patientId, "Check", null, null, null, null, []],
        );
      });
    },
    (err) => err.message.includes("doctor or admin required"),
  );
});

test("RLS Boundaries: Staff can read prescriptions; Anon cannot", async (t) => {
  if (skipIfNoDb(t)) return;

  const doctorId = await asServiceRole(() =>
    createTestUser(`doc_${randomUUID()}@prescription.test`, "doctor"),
  );
  const { campId, dayId } = await asServiceRole(() => createTestCamp());
  const patientId = await asServiceRole(() =>
    createTestPatient(campId, dayId, "waiting"),
  );

  // Submit prescription
  await asAuthenticated(doctorId, async () => {
    await client.query(
      `select * from public.doctor_submit_prescription($1, $2, $3, $4, $5, $6, $7)`,
      [patientId, "Miopia", null, "Glasses", null, "fixed", ["spectacles"]],
    );
  });

  // Staff (doctor) can select
  const staffRows = await asAuthenticated(doctorId, async () => {
    const { rows } = await client.query(
      `select * from public.prescriptions where patient_id = $1`,
      [patientId],
    );
    return rows;
  });
  assert.equal(staffRows.length, 1);

  // Anon cannot select (permission denied / RLS boundary)
  await assert.rejects(
    async () => {
      await asAnon(async () => {
        await client.query(
          `select * from public.prescriptions where patient_id = $1`,
          [patientId],
        );
      });
    },
    (err) => err.code === "42501" || err.message.includes("permission denied"),
  );
});

test("Unique constraint: treatment_orders (patient_id, kind) WHERE status = 'pending'", async (t) => {
  if (skipIfNoDb(t)) return;

  const doctorId = await asServiceRole(() =>
    createTestUser(`doc_${randomUUID()}@prescription.test`, "doctor"),
  );
  const { campId, dayId } = await asServiceRole(() => createTestCamp());
  const patientId = await asServiceRole(() =>
    createTestPatient(campId, dayId, "waiting"),
  );

  // Create prescription
  const pRes = await asAuthenticated(doctorId, async () => {
    const { rows } = await client.query(
      `select * from public.doctor_submit_prescription($1, $2, $3, $4, $5, $6, $7)`,
      [patientId, "Diagnosis", null, null, null, null, ["ot"]],
    );
    return rows[0];
  });

  // Attempt to insert duplicate pending order of kind 'ot' for same patient
  await assert.rejects(
    async () => {
      await asServiceRole(async () => {
        await client.query(
          `insert into public.treatment_orders (prescription_id, patient_id, camp_id, kind, status)
           values ($1, $2, $3, 'ot', 'pending')`,
          [pRes.prescription_id, patientId, campId],
        );
      });
    },
    (err) =>
      err.code === "23505" || err.message.includes("treatment_orders_pending_patient_kind_idx"),
  );

  // Inserting non-pending status ('fulfilled') for same kind works without conflict
  await asServiceRole(async () => {
    await client.query(
      `insert into public.treatment_orders (prescription_id, patient_id, camp_id, kind, status)
       values ($1, $2, $3, 'ot', 'fulfilled')`,
      [pRes.prescription_id, patientId, campId],
    );
  });
});
