/**
 * Ticket #95 — Theatre overflow to the next camp day DB test suite.
 * Tests rollover reservation, serialization concurrency, returning patient status,
 * cancellation slot return, and clean refusal when no capacity remains.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const VENUE = "ot-overflow-test-venue";

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
           and to_regprocedure('public.doctor_submit_prescription(uuid,text,text,text,text,text,text[])') is not null
           and to_regprocedure('public.resolve_treatment_order(uuid,text,date,text)') is not null as ok`,
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
      "[ot-overflow.db] local Postgres unavailable — DB tests skipped",
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
        `delete from public.profiles where email like '%@otoverflow.test'`,
      );
      await adminClient.query(
        `delete from auth.users where email like '%@otoverflow.test'`,
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

let dayCounter = 1;

async function seedTestCampWithDays() {
  const doctorId = randomUUID();
  const adminId = randomUUID();

  const activeRes = await adminClient.query(
    `select id from public.camps where is_active = true limit 1`,
  );
  let campId;
  if (activeRes.rows[0]) {
    campId = activeRes.rows[0].id;
  } else {
    campId = randomUUID();
    await adminClient.query(
      `insert into public.camps (id, name, venue, is_active) values ($1, 'OT Overflow Camp', $2, true)`,
      [campId, VENUE],
    );
  }

  const day1Id = randomUUID();
  const day2Id = randomUUID();
  const day3Id = randomUUID();
  const seq = dayCounter++;
  const day1Date = `2098-${String((seq * 3) % 12 + 1).padStart(2, "0")}-${String((seq % 25) + 1).padStart(2, "0")}`;
  const day2Date = `2099-${String((seq * 3) % 12 + 1).padStart(2, "0")}-${String((seq % 25) + 1).padStart(2, "0")}`;
  const day3Date = `2100-${String((seq * 3) % 12 + 1).padStart(2, "0")}-${String((seq % 25) + 1).padStart(2, "0")}`;

  // Day 1: theatre_capacity = 0 (full)
  await adminClient.query(
    `insert into public.camp_days (id, camp_id, day_date, seat_limit, theatre_capacity) values ($1, $2, $3, 100, 0)`,
    [day1Id, campId, day1Date],
  );

  // Day 2: theatre_capacity = 1 (1 slot)
  await adminClient.query(
    `insert into public.camp_days (id, camp_id, day_date, seat_limit, theatre_capacity) values ($1, $2, $3, 100, 1)`,
    [day2Id, campId, day2Date],
  );

  // Day 3: theatre_capacity = 0 (full)
  await adminClient.query(
    `insert into public.camp_days (id, camp_id, day_date, seat_limit, theatre_capacity) values ($1, $2, $3, 100, 0)`,
    [day3Id, campId, day3Date],
  );

  // Doctor and Admin profiles
  await adminClient.query(
    `insert into auth.users (id, email) values ($1, $2)`,
    [doctorId, `${doctorId}@otoverflow.test`],
  );
  await adminClient.query(
    `insert into public.profiles (id, full_name, role) values ($1, 'Test Doctor', 'doctor')`,
    [doctorId],
  );

  await adminClient.query(
    `insert into auth.users (id, email) values ($1, $2)`,
    [adminId, `${adminId}@otoverflow.test`],
  );
  await adminClient.query(
    `insert into public.profiles (id, full_name, role) values ($1, 'Test Admin', 'admin')`,
    [adminId],
  );

  return { campId, doctorId, adminId, day1Id, day1Date, day2Id, day2Date, day3Id, day3Date };
}

async function createWaitingPatient(campId, dayId, regNo, name) {
  const patientId = randomUUID();
  await adminClient.query(
    `insert into public.patients (id, camp_id, camp_day_id, reg_no, full_name, queue_status, gender, age)
     values ($1, $2, $3, $4, $5, 'waiting', 'M', 50)`,
    [patientId, campId, dayId, regNo, name],
  );
  return patientId;
}

describe("Theatre overflow to next camp day DB tests", () => {
  test("two simultaneous RPC calls rolling over into 1 remaining slot on a future day yield 1 success and 1 refusal", async (t) => {
    if (skipIfNoDb(t)) return;

    const { campId, doctorId, day1Id, day2Id, day2Date } = await seedTestCampWithDays();
    const patient1Id = await createWaitingPatient(campId, day1Id, Math.floor(Math.random() * 800000) + 100000, "Patient One");
    const patient2Id = await createWaitingPatient(campId, day1Id, Math.floor(Math.random() * 800000) + 100000, "Patient Two");

    const c1 = newClient();
    const c2 = newClient();
    await c1.connect();
    await c2.connect();

    try {
      const req1 = asAuthenticated(c1, doctorId, async () => {
        const { rows } = await c1.query(
          `select * from public.doctor_submit_prescription(
             $1::uuid, 'Cataract', 'RE nuclear sclerosis', 'Eye drops', 'Follow up', null, array['ot']
           )`,
          [patient1Id],
        );
        return rows[0];
      });

      const req2 = asAuthenticated(c2, doctorId, async () => {
        const { rows } = await c2.query(
          `select * from public.doctor_submit_prescription(
             $1::uuid, 'Cataract', 'LE nuclear sclerosis', 'Eye drops', 'Follow up', null, array['ot']
           )`,
          [patient2Id],
        );
        return rows[0];
      });

      const [res1, res2] = await Promise.allSettled([req1, req2]);

      const succeeded = [res1, res2].filter((r) => r.status === "fulfilled");
      const rejected = [res1, res2].filter((r) => r.status === "rejected");

      assert.equal(succeeded.length, 1, "Exactly 1 rollover reservation must succeed");
      assert.equal(rejected.length, 1, "Exactly 1 rollover reservation must be refused");

      const errMessage = rejected[0].reason?.message || "";
      assert.match(
        errMessage,
        /Camp has no theatre capacity remaining|Post-camp surgery date and venue must be configured by admin/i,
        "Refused call must surface structured error: Camp has no theatre capacity remaining",
      );

      const successVal = succeeded[0].value;
      assert.equal(successVal.scheduled_camp_day_id, day2Id, "Successful order must reserve Day 2 ID");

      // Verify DB state for scheduled day
      const { rows: orders } = await adminClient.query(
        `select t.id, t.patient_id, t.scheduled_camp_day_id, t.status
         from public.treatment_orders t
         where t.kind = 'ot' and t.scheduled_camp_day_id = $1 and t.status != 'cancelled'`,
        [day2Id],
      );
      assert.equal(orders.length, 1, "Exactly 1 active OT order scheduled for Day 2");

      // Verify rejected patient has no orders or prescriptions (no partial write)
      const failedPatientId = res1.status === "rejected" ? patient1Id : patient2Id;
      const { rows: failedOrders } = await adminClient.query(
        `select id from public.treatment_orders where patient_id = $1`,
        [failedPatientId],
      );
      assert.equal(failedOrders.length, 0, "Refused patient must have 0 treatment orders written");
    } finally {
      await c1.end();
      await c2.end();
    }
  });

  test("returning patient stays seen and scans at counter with scheduled order", async (t) => {
    if (skipIfNoDb(t)) return;

    const { campId, doctorId, day1Id, day2Id, day2Date } = await seedTestCampWithDays();
    const patientId = await createWaitingPatient(campId, day1Id, Math.floor(Math.random() * 800000) + 100000, "Returning Patient");

    const c = newClient();
    await c.connect();

    try {
      // Doctor orders OT on Day 1, which rolls over to Day 2
      const submitRes = await asAuthenticated(c, doctorId, async () => {
        const { rows } = await c.query(
          `select * from public.doctor_submit_prescription(
             $1::uuid, 'Cataract', 'Bilateral', 'Post-op drops', 'Surgery', null, array['ot']
           )`,
          [patientId],
        );
        return rows[0];
      });

      assert.equal(submitRes.scheduled_camp_day_id, day2Id, "Order must be scheduled for Day 2");
      assert.equal(submitRes.queue_status, "seen", "Patient queue status moves to seen");

      // Patient returns on Day 2: lookup_patient_scan at Theatre counter
      const lookupRes = await asAuthenticated(c, doctorId, async () => {
        const { rows } = await c.query(
          `select * from public.lookup_patient_scan($1::uuid, null)`,
          [patientId],
        );
        return rows[0];
      });

      assert.equal(lookupRes.queue_status, "seen", "Queue status remains seen upon returning");
      assert.equal(lookupRes.ot_scheduled_day_id, day2Id, "Scan finds scheduled Day 2 ID");
    } finally {
      await c.end();
    }
  });

  test("cancelling a rolled-over OT order returns slot to that scheduled camp day pool", async (t) => {
    if (skipIfNoDb(t)) return;

    const { campId, doctorId, day1Id, day2Id } = await seedTestCampWithDays();
    const patient1Id = await createWaitingPatient(campId, day1Id, Math.floor(Math.random() * 800000) + 100000, "Patient Alpha");
    const patient2Id = await createWaitingPatient(campId, day1Id, Math.floor(Math.random() * 800000) + 100000, "Patient Beta");

    const c = newClient();
    await c.connect();

    try {
      // Patient 1 takes the 1 slot on Day 2
      const sub1 = await asAuthenticated(c, doctorId, async () => {
        const { rows } = await c.query(
          `select * from public.doctor_submit_prescription(
             $1::uuid, 'Cataract', 'RE', 'Drops', 'OT', null, array['ot']
           )`,
          [patient1Id],
        );
        return rows[0];
      });
      assert.equal(sub1.scheduled_camp_day_id, day2Id);

      // Patient 2 attempts OT order -> fails because Day 2 is now full
      let failedErr = null;
      try {
        await asAuthenticated(c, doctorId, async () => {
          await c.query(
            `select * from public.doctor_submit_prescription(
               $1::uuid, 'Cataract', 'LE', 'Drops', 'OT', null, array['ot']
             )`,
            [patient2Id],
          );
        });
      } catch (err) {
        failedErr = err;
      }
      assert.ok(failedErr, "Should fail when Day 2 capacity is exhausted");
      assert.match(failedErr.message, /Camp has no theatre capacity remaining|Post-camp surgery date and venue must be configured by admin/i);

      // Get Patient 1's OT treatment order id
      const { rows: p1Orders } = await adminClient.query(
        `select id from public.treatment_orders where patient_id = $1 and kind = 'ot'`,
        [patient1Id],
      );
      const p1OrderId = p1Orders[0].id;

      // Cancel Patient 1's rolled-over order
      await asAuthenticated(c, doctorId, async () => {
        await c.query(
          `select * from public.resolve_treatment_order($1::uuid, 'cancelled', null, null)`,
          [p1OrderId],
        );
      });

      // Now Patient 2 attempts OT order again -> must succeed!
      const sub2 = await asAuthenticated(c, doctorId, async () => {
        const { rows } = await c.query(
          `select * from public.doctor_submit_prescription(
             $1::uuid, 'Cataract', 'LE', 'Drops', 'OT', null, array['ot']
           )`,
          [patient2Id],
        );
        return rows[0];
      });
      assert.equal(sub2.scheduled_camp_day_id, day2Id, "Patient 2 gets the returned slot on Day 2");
    } finally {
      await c.end();
    }
  });

  test("clean refusal with no partial write when no future camp day has capacity", async (t) => {
    if (skipIfNoDb(t)) return;

    // Create a camp where all 3 days have theatre_capacity = 0
    const activeRes = await adminClient.query(
      `select id from public.camps where is_active = true limit 1`,
    );
    let campId;
    if (activeRes.rows[0]) {
      campId = activeRes.rows[0].id;
    } else {
      campId = randomUUID();
      await adminClient.query(
        `insert into public.camps (id, name, venue, is_active) values ($1, 'Full Camp', $2, true)`,
      );
    }

    await adminClient.query(
      `delete from public.sms_deliveries where patient_id in (select id from public.patients where camp_id = $1)`,
      [campId],
    );
    await adminClient.query(
      `delete from public.treatment_orders where camp_id = $1`,
      [campId],
    );
    await adminClient.query(
      `delete from public.prescriptions where camp_id = $1`,
      [campId],
    );
    await adminClient.query(
      `delete from public.patients where camp_id = $1`,
      [campId],
    );
    await adminClient.query(
      `delete from public.camp_days where camp_id = $1`,
      [campId],
    );

    const doctorId = randomUUID();
    const day1Id = randomUUID();
    const day2Id = randomUUID();
    const rnd = Math.floor(Math.random() * 200) + 1;
    await adminClient.query(
      `insert into public.camp_days (id, camp_id, day_date, seat_limit, theatre_capacity) values ($1, $2, $3, 100, 0)`,
      [day1Id, campId, `2099-10-${String((rnd % 25) + 1).padStart(2, "0")}`],
    );
    await adminClient.query(
      `insert into public.camp_days (id, camp_id, day_date, seat_limit, theatre_capacity) values ($1, $2, $3, 100, 0)`,
      [day2Id, campId, `2099-11-${String((rnd % 25) + 1).padStart(2, "0")}`],
    );

    await adminClient.query(
      `insert into auth.users (id, email) values ($1, $2)`,
      [doctorId, `${doctorId}@otoverflow.test`],
    );
    await adminClient.query(
      `insert into public.profiles (id, full_name, role) values ($1, 'Test Doctor', 'doctor')`,
      [doctorId],
    );

    const patientId = await createWaitingPatient(campId, day1Id, Math.floor(Math.random() * 800000) + 100000, "Refusal Patient");

    const c = newClient();
    await c.connect();

    try {
      let errRes = null;
      try {
        await asAuthenticated(c, doctorId, async () => {
          await c.query(
            `select * from public.doctor_submit_prescription(
               $1::uuid, 'Cataract', 'Bilateral', 'Meds', 'Advice', null, array['ot']
             )`,
            [patientId],
          );
        });
      } catch (err) {
        errRes = err;
      }

      assert.ok(errRes, "RPC must throw exception when no future day has capacity");
      assert.match(errRes.message, /Camp has no theatre capacity remaining|Post-camp surgery date and venue must be configured by admin/i);

      // Verify no partial write: patient remains in waiting state, 0 prescriptions, 0 treatment orders
      const { rows: patientRows } = await adminClient.query(
        `select queue_status from public.patients where id = $1`,
        [patientId],
      );
      assert.equal(patientRows[0].queue_status, "waiting", "Patient queue status must remain waiting");

      const { rows: rxRows } = await adminClient.query(
        `select id from public.prescriptions where patient_id = $1`,
        [patientId],
      );
      assert.equal(rxRows.length, 0, "No prescription record inserted");

      const { rows: orderRows } = await adminClient.query(
        `select id from public.treatment_orders where patient_id = $1`,
        [patientId],
      );
      assert.equal(orderRows.length, 0, "No treatment order inserted");
    } finally {
      await c.end();
    }
  });
});
