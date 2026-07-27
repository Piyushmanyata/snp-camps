/**
 * #91 — Theatre slot capacity and atomic reservation DB test suite.
 * Tests concurrency serialization when reserving theatre slots, cancelling OT orders,
 * and admin capacity bounds.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const VENUE = "theatre-capacity-test-venue";

/** @type {pg.Client | null} */
let adminClient = null;
let dbAvailable = false;

async function connect() {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await c.connect();
    const { rows } = await c.query(
      `select
         to_regprocedure('public.upsert_camp_day(uuid,date,integer,uuid,integer)') is not null
           and to_regprocedure('public.doctor_submit_prescription(uuid,text,text,text,text,text,text[])') is not null as ok`,
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

function newClient() {
  return new pg.Client({ connectionString: DATABASE_URL });
}

async function setAuth(c, userId, role = "authenticated") {
  await c.query(`select set_config('request.jwt.claim.role', $1, true)`, [role]);
  await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ role, sub: userId }),
  ]);
  if (role === "authenticated") {
    await c.query(`set local role authenticated`);
  }
}

async function asAuthenticated(c, userId, fn) {
  await c.query("begin");
  try {
    await setAuth(c, userId, "authenticated");
    const res = await fn();
    await c.query("commit");
    return res;
  } catch (err) {
    await c.query("rollback");
    throw err;
  }
}

test.before(async () => {
  adminClient = await connect();
  dbAvailable = Boolean(adminClient);
  if (!dbAvailable) {
    console.warn(
      "[theatre-capacity-concurrency.db] local Postgres unavailable — DB tests skipped",
    );
  }
});

test.after(async () => {
  if (adminClient) {
    try {
      await adminClient.query(
        `delete from public.treatment_orders where camp_id in (
           select id from public.camps where venue = $1
         )`,
        [VENUE],
      );
      await adminClient.query(
        `delete from public.prescriptions where camp_id in (
           select id from public.camps where venue = $1
         )`,
        [VENUE],
      );
      await adminClient.query(
        `delete from public.patients where camp_id in (
           select id from public.camps where venue = $1
         )`,
        [VENUE],
      );
      await adminClient.query(
        `delete from public.camp_days where camp_id in (
           select id from public.camps where venue = $1
         )`,
        [VENUE],
      );
      await adminClient.query(
        `delete from public.profiles where email like '%@theatre.test'`,
      );
      await adminClient.query(
        `delete from auth.users where email like '%@theatre.test'`,
      );
    } catch {
      /* ignore */
    }
    await adminClient.end();
  }
});

function skipIfNoDb(t) {
  if (!dbAvailable) {
    t.skip("local Postgres not available");
    return true;
  }
  return false;
}

async function seedTestEnvironment({ seatLimit = 100, theatreCapacity = 1 } = {}) {
  const dayId = randomUUID();
  const doctorId = randomUUID();
  const adminId = randomUUID();

  // Reuse existing active camp or create one if none exists
  const activeRes = await adminClient.query(
    `select id from public.camps where is_active = true limit 1`,
  );
  let campId;
  if (activeRes.rows[0]) {
    campId = activeRes.rows[0].id;
  } else {
    campId = randomUUID();
    await adminClient.query(
      `insert into public.camps (id, name, venue, is_active) values ($1, 'Theatre Test Camp', $2, true)`,
      [campId, VENUE],
    );
  }

  const dayDateIso = `2099-${String(Math.floor(Math.random() * 11) + 1).padStart(2, "0")}-${String(Math.floor(Math.random() * 25) + 1).padStart(2, "0")}`;

  await adminClient.query(
    `insert into public.camp_days (id, camp_id, day_date, seat_limit, theatre_capacity) values ($1, $2, $3, $4, $5)`,
    [dayId, campId, dayDateIso, seatLimit, theatreCapacity],
  );

  // Create doctor and admin profiles
  await adminClient.query(
    `insert into auth.users (id, email) values ($1, $2)`,
    [doctorId, `${doctorId}@theatre.test`],
  );
  await adminClient.query(
    `insert into public.profiles (id, full_name, role) values ($1, 'Test Doctor', 'doctor')`,
    [doctorId],
  );

  await adminClient.query(
    `insert into auth.users (id, email) values ($1, $2)`,
    [adminId, `${adminId}@theatre.test`],
  );
  await adminClient.query(
    `insert into public.profiles (id, full_name, role) values ($1, 'Test Admin', 'admin')`,
    [adminId],
  );

  return { campId, dayId, doctorId, adminId, dayDateIso };
}

async function createWaitingPatient(campId, dayId, regNo, name) {
  const patientId = randomUUID();
  await adminClient.query(
    `insert into public.patients (id, camp_id, camp_day_id, reg_no, full_name, queue_status, gender, age)
     values ($1, $2, $3, $4, $5, 'waiting', 'M', 45)`,
    [patientId, campId, dayId, regNo, name],
  );
  return patientId;
}

describe("Theatre slot capacity and atomic reservation", () => {
  test("two simultaneous RPC calls attempt to reserve the last remaining theatre slot: exactly one succeeds and one is rejected", async (t) => {
    if (skipIfNoDb(t)) return;

    const { campId, dayId, doctorId } = await seedTestEnvironment({ theatreCapacity: 1 });
    const patient1Id = await createWaitingPatient(campId, dayId, Math.floor(Math.random() * 800000) + 100000, "Patient One");
    const patient2Id = await createWaitingPatient(campId, dayId, Math.floor(Math.random() * 800000) + 100000, "Patient Two");

    const c1 = newClient();
    const c2 = newClient();

    await c1.connect();
    await c2.connect();

    try {
      // Fire two simultaneous RPC calls for OT reservation
      const req1 = asAuthenticated(c1, doctorId, async () => {
        const { rows } = await c1.query(
          `select * from public.doctor_submit_prescription(
             $1::uuid, 'Caturact', 'RE nuclear sclerosis', 'Eye drops', 'Follow up', null, array['ot']
           )`,
          [patient1Id],
        );
        return rows[0];
      });

      const req2 = asAuthenticated(c2, doctorId, async () => {
        const { rows } = await c2.query(
          `select * from public.doctor_submit_prescription(
             $1::uuid, 'Caturact', 'LE nuclear sclerosis', 'Eye drops', 'Follow up', null, array['ot']
           )`,
          [patient2Id],
        );
        return rows[0];
      });

      const [res1, res2] = await Promise.allSettled([req1, req2]);

      const succeeded = [res1, res2].filter((r) => r.status === "fulfilled");
      const rejected = [res1, res2].filter((r) => r.status === "rejected");

      assert.equal(succeeded.length, 1, "Exactly one reservation must succeed");
      assert.equal(rejected.length, 1, "Exactly one reservation must be rejected");

      const errMessage = rejected[0].reason?.message || "";
      assert.match(
        errMessage,
        /Theatre slot capacity reached for this camp day|Camp has no theatre capacity remaining|Post-camp surgery date and venue must be configured by admin/i,
        "Rejected call must surface structured error message: Theatre slot capacity reached for this camp day",
      );

      // Verify DB invariant: exactly 1 active OT order exists for this camp day
      const { rows: orderRows } = await adminClient.query(
        `select t.id, t.patient_id, t.status
         from public.treatment_orders t
         join public.patients p on p.id = t.patient_id
         where p.camp_day_id = $1 and t.kind = 'ot' and t.status != 'cancelled'`,
        [dayId],
      );

      assert.equal(orderRows.length, 1, "DB must record exactly 1 active OT order");
    } finally {
      await c1.end();
      await c2.end();
    }
  });

  test("cancelling an OT order returns the slot to the pool immediately", async (t) => {
    if (skipIfNoDb(t)) return;

    const { campId, dayId, doctorId } = await seedTestEnvironment({ theatreCapacity: 1 });
    const patient1Id = await createWaitingPatient(campId, dayId, Math.floor(Math.random() * 800000) + 100000, "Patient Three");
    const patient2Id = await createWaitingPatient(campId, dayId, Math.floor(Math.random() * 800000) + 100000, "Patient Four");

    const c1 = newClient();
    await c1.connect();

    try {
      // Doctor reserves slot for patient 1
      await asAuthenticated(c1, doctorId, async () => {
        await c1.query(
          `select * from public.doctor_submit_prescription(
             $1::uuid, 'Caturact', 'Exam', 'Drops', 'Advice', null, array['ot']
           )`,
          [patient1Id],
        );
      });

      // Verify second doctor submit for patient 2 fails because slot is full
      await assert.rejects(
        asAuthenticated(c1, doctorId, async () => {
          await c1.query(
            `select * from public.doctor_submit_prescription(
               $1::uuid, 'Caturact', 'Exam', 'Drops', 'Advice', null, array['ot']
             )`,
            [patient2Id],
          );
        }),
        /Theatre slot capacity reached for this camp day|Camp has no theatre capacity remaining|Post-camp surgery date and venue must be configured by admin/i,
      );

      // Cancel patient 1's OT order
      await adminClient.query(
        `update public.treatment_orders set status = 'cancelled' where patient_id = $1 and kind = 'ot'`,
        [patient1Id],
      );

      // Verify lookup_patient_scan now reflects 1 remaining slot
      const scanRows = await asAuthenticated(c1, doctorId, async () => {
        const { rows } = await c1.query(
          `select theatre_capacity, theatre_reserved, theatre_remaining
           from public.lookup_patient_scan($1::uuid, null::integer)`,
          [patient2Id],
        );
        return rows;
      });
      assert.equal(scanRows[0].theatre_capacity, 1);
      assert.equal(scanRows[0].theatre_reserved, 0);
      assert.equal(scanRows[0].theatre_remaining, 1);

      // Patient 2 reservation now succeeds immediately
      const p2Sub = await asAuthenticated(c1, doctorId, async () => {
        const { rows } = await c1.query(
          `select * from public.doctor_submit_prescription(
             $1::uuid, 'Caturact', 'Exam', 'Drops', 'Advice', null, array['ot']
           )`,
          [patient2Id],
        );
        return rows;
      });
      assert.equal(p2Sub.length, 1);
      assert.equal(p2Sub[0].created_orders_count, 1);
    } finally {
      await c1.end();
    }
  });

  test("admin setting capacity below existing reserved count is rejected", async (t) => {
    if (skipIfNoDb(t)) return;

    const { campId, dayId, doctorId, adminId, dayDateIso } = await seedTestEnvironment({ theatreCapacity: 5 });
    const patient1Id = await createWaitingPatient(campId, dayId, Math.floor(Math.random() * 800000) + 100000, "Patient Five");
    const patient2Id = await createWaitingPatient(campId, dayId, Math.floor(Math.random() * 800000) + 100000, "Patient Six");

    const c1 = newClient();
    await c1.connect();

    try {
      // Reserve 2 OT slots as doctor
      await asAuthenticated(c1, doctorId, async () => {
        await c1.query(
          `select * from public.doctor_submit_prescription($1::uuid, 'Diag', 'Exam', 'Med', 'Adv', null, array['ot'])`,
          [patient1Id],
        );
      });
      await asAuthenticated(c1, doctorId, async () => {
        await c1.query(
          `select * from public.doctor_submit_prescription($1::uuid, 'Diag', 'Exam', 'Med', 'Adv', null, array['ot'])`,
          [patient2Id],
        );
      });

      // Attempt to lower capacity to 1 (below 2 reserved slots) as admin -> must reject
      await assert.rejects(
        asAuthenticated(c1, adminId, async () => {
          await c1.query(
            `select * from public.upsert_camp_day($1::uuid, $2::date, 100, $3::uuid, 1)`,
            [campId, dayDateIso, dayId],
          );
        }),
        /THEATRE_CAPACITY_BELOW_RESERVED:reserved=2/i,
      );

      // Setting capacity to 2 (equal to reserved count) as admin -> succeeds
      const okRows = await asAuthenticated(c1, adminId, async () => {
        const { rows } = await c1.query(
          `select * from public.upsert_camp_day($1::uuid, $2::date, 100, $3::uuid, 2)`,
          [campId, dayDateIso, dayId],
        );
        return rows;
      });
      assert.equal(okRows[0].theatre_capacity, 2);
    } finally {
      await c1.end();
    }
  });

  test("non-OT orders (pharmacy, spectacles) do not consume theatre capacity", async (t) => {
    if (skipIfNoDb(t)) return;

    const { campId, dayId, doctorId } = await seedTestEnvironment({ theatreCapacity: 0 }); // 0 slots
    const patientId = await createWaitingPatient(campId, dayId, Math.floor(Math.random() * 800000) + 100000, "Patient Seven");

    const c1 = newClient();
    await c1.connect();

    try {
      // OT reservation fails
      await assert.rejects(
        asAuthenticated(c1, doctorId, async () => {
          await c1.query(
            `select * from public.doctor_submit_prescription($1::uuid, 'Diag', 'Exam', 'Med', 'Adv', 'fixed', array['ot'])`,
            [patientId],
          );
        }),
        /Theatre slot capacity reached for this camp day|Camp has no theatre capacity remaining|Post-camp surgery date and venue must be configured by admin/i,
      );

      // Pharmacy + spectacles reservation succeeds even when theatre is 0
      const res = await asAuthenticated(c1, doctorId, async () => {
        const { rows } = await c1.query(
          `select * from public.doctor_submit_prescription($1::uuid, 'Diag', 'Exam', 'Med', 'Adv', 'fixed', array['pharmacy', 'spectacles'])`,
          [patientId],
        );
        return rows;
      });
      assert.equal(res.length, 1);
      assert.equal(res[0].created_orders_count, 2);
    } finally {
      await c1.end();
    }
  });
});
