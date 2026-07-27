/**
 * Ticket #96 — Prescription Edit, Lock on First Fulfillment, and Append-Only Amendments DB Test Suite.
 *
 * Verifies:
 * 1. Unlocked edit path & order reconciliation (adding/removing destinations on a seen patient).
 * 2. Order re-creation after cancellation.
 * 3. Locking transition when an order becomes terminal (fulfilled/deferred/cancelled).
 * 4. Rejection of direct edit on locked prescription with error "Prescription is locked because treatment orders have been acted upon".
 * 5. Successful append of amendment on locked prescription via add_prescription_amendment.
 * 6. Volunteer role rejection for edit and amendment actions.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const VENUE = "prescription-lock-test-venue";

/** @type {pg.Client | null} */
let client = null;
let dbAvailable = false;

async function connect() {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await c.connect();
    const { rows } = await c.query(
      `select to_regclass('public.prescription_amendments') is not null as ok`,
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
      "[prescription-edit-lock.db] local Postgres unavailable or migration missing — DB tests skipped",
    );
  }
});

test.after(async () => {
  if (client) {
    try {
      await client.query(
        `delete from public.prescription_amendments where prescription_id in (
           select id from public.prescriptions where camp_id in (
             select id from public.camps where venue = $1
           )
         )`,
        [VENUE],
      );
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
        `delete from public.profiles where email like '%@prescription-lock.test'`,
      );
      await client.query(
        `delete from auth.users where email like '%@prescription-lock.test'`,
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
  await client.query(`update public.camps set is_active = false where is_active = true`);
  const campId = randomUUID();
  const dayId = randomUUID();
  await client.query(
    `insert into public.camps (id, name, venue, is_active) values ($1, $2, $3, true)`,
    [campId, "Prescription Lock Test Camp", VENUE],
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

test("Unlocked edit path & order reconciliation", async (t) => {
  if (skipIfNoDb(t)) return;

  const doctorId = await asServiceRole(() =>
    createTestUser(`doc_${randomUUID()}@prescription-lock.test`, "doctor"),
  );
  const { campId, dayId } = await asServiceRole(() => createTestCamp());
  const patientId = await asServiceRole(() =>
    createTestPatient(campId, dayId, "waiting"),
  );

  // Initial submission with OT and Pharmacy
  const res1 = await asAuthenticated(doctorId, async () => {
    const { rows } = await client.query(
      `select * from public.doctor_submit_prescription($1, $2, $3, $4, $5, $6, $7)`,
      [patientId, "Initial Diagnosis", "Exam 1", "Meds 1", "Advice 1", null, ["ot", "pharmacy"]],
    );
    return rows[0];
  });
  assert.equal(res1.queue_status, "seen");

  // Re-open / lookup patient scan
  const lookup1 = await asAuthenticated(doctorId, async () => {
    const { rows } = await client.query(
      `select * from public.lookup_patient_scan($1, null)`,
      [patientId],
    );
    return rows[0];
  });
  assert.equal(lookup1.diagnosis, "Initial Diagnosis");
  assert.equal(lookup1.is_locked, false);
  assert.deepEqual(lookup1.destinations.sort(), ["ot", "pharmacy"].sort());

  // Edit prescription: remove OT, add Spectacles (destinations = ['pharmacy', 'spectacles'])
  await asAuthenticated(doctorId, async () => {
    await client.query(
      `select * from public.doctor_submit_prescription($1, $2, $3, $4, $5, $6, $7)`,
      [patientId, "Updated Diagnosis", "Exam 2", "Meds 2", "Advice 2", "fixed", ["pharmacy", "spectacles"]],
    );
  });

  // Verify orders reconciled: OT deleted (status was pending), Pharmacy kept, Spectacles added
  const { rows: tRows } = await client.query(
    `select kind, status from public.treatment_orders where patient_id = $1 order by kind`,
    [patientId],
  );
  assert.equal(tRows.length, 2);
  assert.deepEqual(
    tRows.map((r) => r.kind),
    ["pharmacy", "spectacles"],
  );
});

test("Order re-creation after cancellation / removal", async (t) => {
  if (skipIfNoDb(t)) return;

  const doctorId = await asServiceRole(() =>
    createTestUser(`doc_${randomUUID()}@prescription-lock.test`, "doctor"),
  );
  const { campId, dayId } = await asServiceRole(() => createTestCamp());
  const patientId = await asServiceRole(() =>
    createTestPatient(campId, dayId, "waiting"),
  );

  // Submit with OT
  await asAuthenticated(doctorId, async () => {
    await client.query(
      `select * from public.doctor_submit_prescription($1, $2, $3, $4, $5, $6, $7)`,
      [patientId, "Diag", null, null, null, null, ["ot"]],
    );
  });

  // Remove OT in edit
  await asAuthenticated(doctorId, async () => {
    await client.query(
      `select * from public.doctor_submit_prescription($1, $2, $3, $4, $5, $6, $7)`,
      [patientId, "Diag", null, null, null, null, []],
    );
  });

  // Re-add OT in subsequent edit
  await asAuthenticated(doctorId, async () => {
    await client.query(
      `select * from public.doctor_submit_prescription($1, $2, $3, $4, $5, $6, $7)`,
      [patientId, "Diag", null, null, null, null, ["ot"]],
    );
  });

  const { rows: tRows } = await client.query(
    `select kind, status from public.treatment_orders where patient_id = $1`,
    [patientId],
  );
  assert.equal(tRows.length, 1);
  assert.equal(tRows[0].kind, "ot");
  assert.equal(tRows[0].status, "pending");
});

test("Locking transition when an order becomes terminal (fulfilled/deferred/cancelled)", async (t) => {
  if (skipIfNoDb(t)) return;

  const doctorId = await asServiceRole(() =>
    createTestUser(`doc_${randomUUID()}@prescription-lock.test`, "doctor"),
  );
  const { campId, dayId } = await asServiceRole(() => createTestCamp());
  const patientId = await asServiceRole(() =>
    createTestPatient(campId, dayId, "waiting"),
  );

  // Submit prescription with pharmacy order
  await asAuthenticated(doctorId, async () => {
    await client.query(
      `select * from public.doctor_submit_prescription($1, $2, $3, $4, $5, $6, $7)`,
      [patientId, "Diag", null, null, null, null, ["pharmacy"]],
    );
  });

  // Get order ID
  const { rows: orderRows } = await client.query(
    `select id from public.treatment_orders where patient_id = $1 and kind = 'pharmacy'`,
    [patientId],
  );
  const orderId = orderRows[0].id;

  // Resolve order as fulfilled at counter desk
  await asAuthenticated(doctorId, async () => {
    await client.query(
      `select * from public.resolve_treatment_order($1, 'fulfilled', null, null)`,
      [orderId],
    );
  });

  // Lookup scan should now return is_locked = true
  const lookup = await asAuthenticated(doctorId, async () => {
    const { rows } = await client.query(
      `select * from public.lookup_patient_scan($1, null)`,
      [patientId],
    );
    return rows[0];
  });
  assert.equal(lookup.is_locked, true);

  // Direct edit via doctor_submit_prescription MUST be rejected with exact error
  await assert.rejects(
    async () => {
      await asAuthenticated(doctorId, async () => {
        await client.query(
          `select * from public.doctor_submit_prescription($1, $2, $3, $4, $5, $6, $7)`,
          [patientId, "Attempted Edit", null, null, null, null, ["pharmacy"]],
        );
      });
    },
    (err) => err.message.includes("Prescription is locked because treatment orders have been acted upon"),
  );
});

test("Successful append of amendment on locked prescription", async (t) => {
  if (skipIfNoDb(t)) return;

  const doctorId = await asServiceRole(() =>
    createTestUser(`doc_${randomUUID()}@prescription-lock.test`, "doctor"),
  );
  const { campId, dayId } = await asServiceRole(() => createTestCamp());
  const patientId = await asServiceRole(() =>
    createTestPatient(campId, dayId, "waiting"),
  );

  // Submit prescription
  const pRes = await asAuthenticated(doctorId, async () => {
    const { rows } = await client.query(
      `select * from public.doctor_submit_prescription($1, $2, $3, $4, $5, $6, $7)`,
      [patientId, "Original Diagnosis", "Original Exam", null, null, null, ["ot"]],
    );
    return rows[0];
  });
  const prescriptionId = pRes.prescription_id;

  // Lock prescription by fulfilling OT order
  const { rows: orderRows } = await client.query(
    `select id from public.treatment_orders where patient_id = $1`,
    [patientId],
  );
  await asAuthenticated(doctorId, async () => {
    await client.query(
      `select * from public.resolve_treatment_order($1, 'fulfilled', null, null)`,
      [orderRows[0].id],
    );
  });

  // Append amendment via add_prescription_amendment RPC
  const amendRes = await asAuthenticated(doctorId, async () => {
    const { rows } = await client.query(
      `select * from public.add_prescription_amendment($1, $2)`,
      [prescriptionId, "Patient requires post-op antibiotics drop twice daily."],
    );
    return rows[0];
  });

  assert.ok(amendRes);
  assert.equal(amendRes.prescription_id, prescriptionId);
  assert.equal(amendRes.author_id, doctorId);
  assert.equal(amendRes.content, "Patient requires post-op antibiotics drop twice daily.");

  // Original prescription body remains untouched
  const { rows: pCheck } = await client.query(
    `select diagnosis from public.prescriptions where id = $1`,
    [prescriptionId],
  );
  assert.equal(pCheck[0].diagnosis, "Original Diagnosis");

  // Lookup scan includes amendment in amendments array
  const lookup = await asAuthenticated(doctorId, async () => {
    const { rows } = await client.query(
      `select * from public.lookup_patient_scan($1, null)`,
      [patientId],
    );
    return rows[0];
  });
  assert.equal(lookup.amendments.length, 1);
  assert.equal(lookup.amendments[0].content, "Patient requires post-op antibiotics drop twice daily.");
});

test("Volunteer role rejection for edit and amendment actions", async (t) => {
  if (skipIfNoDb(t)) return;

  const doctorId = await asServiceRole(() =>
    createTestUser(`doc_${randomUUID()}@prescription-lock.test`, "doctor"),
  );
  const volId = await asServiceRole(() =>
    createTestUser(`vol_${randomUUID()}@prescription-lock.test`, "volunteer"),
  );
  const { campId, dayId } = await asServiceRole(() => createTestCamp());
  const patientId = await asServiceRole(() =>
    createTestPatient(campId, dayId, "waiting"),
  );

  // Doctor submits initial prescription
  const pRes = await asAuthenticated(doctorId, async () => {
    const { rows } = await client.query(
      `select * from public.doctor_submit_prescription($1, $2, $3, $4, $5, $6, $7)`,
      [patientId, "Diag", null, null, null, null, []],
    );
    return rows[0];
  });

  // Volunteer attempting edit is rejected
  await assert.rejects(
    async () => {
      await asAuthenticated(volId, async () => {
        await client.query(
          `select * from public.doctor_submit_prescription($1, $2, $3, $4, $5, $6, $7)`,
          [patientId, "Vol Edit", null, null, null, null, []],
        );
      });
    },
    (err) => err.message.includes("doctor or admin required"),
  );

  // Volunteer attempting amendment is rejected
  await assert.rejects(
    async () => {
      await asAuthenticated(volId, async () => {
        await client.query(
          `select * from public.add_prescription_amendment($1, $2)`,
          [pRes.prescription_id, "Vol Amendment"],
        );
      });
    },
    (err) => err.message.includes("doctor or admin required"),
  );
});
