/**
 * Ticket #99 & #100 — Deferral state, snapshot immutability, SMS ledger, and admin lists DB test suite.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const VENUE = "deferral-test-venue";

/** @type {pg.Client | null} */
let adminClient = null;
let dbAvailable = false;
let seqCounter = 1;

async function connect() {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await c.connect();
    const { rows } = await c.query(
      `select
         to_regprocedure('public.resolve_treatment_order(uuid,text,date,text)') is not null
           and to_regprocedure('public.doctor_submit_prescription(uuid,text,text,text,text,text,text[])') is not null
           and to_regprocedure('public.admin_list_deferred_orders(uuid,text)') is not null as ok`,
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
      "[deferral.db] local Postgres unavailable — DB tests skipped",
    );
  }
});

test.after(async () => {
  if (adminClient) {
    try {
      await adminClient.query(
        `delete from public.sms_deliveries where patient_id in (
           select p.id from public.patients p join public.camps c on c.id = p.camp_id where c.venue = $1
         )`,
        [VENUE],
      );
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
        `delete from public.profiles where email like '%@deferral.test'`,
      );
      await adminClient.query(
        `delete from auth.users where email like '%@deferral.test'`,
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

async function seedTestEnvironment(opts = {}) {
  const doctorId = randomUUID();
  const adminId = randomUUID();
  const dayId = randomUUID();

  const seq = seqCounter++;
  const dayDateIso = `2099-${String((seq * 3) % 12 + 1).padStart(2, "0")}-${String((seq % 25) + 1).padStart(2, "0")}`;

  const specDate = opts.spectaclesDate !== undefined ? opts.spectaclesDate : "2099-10-15";
  const specVenue = opts.spectaclesVenue !== undefined ? opts.spectaclesVenue : "Community Hall, Ward 4";
  const surgDate = opts.surgeryDate !== undefined ? opts.surgeryDate : "2099-11-20";
  const surgVenue = opts.surgeryVenue !== undefined ? opts.surgeryVenue : "District Hospital OT, Eye Ward";

  const activeRes = await adminClient.query(
    `select id from public.camps where is_active = true limit 1`,
  );
  let campId;
  if (activeRes.rows[0]) {
    campId = activeRes.rows[0].id;
    await adminClient.query(
      `update public.camps set
         spectacles_collection_date = $2, spectacles_collection_venue = $3,
         post_camp_surgery_date = $4, post_camp_surgery_venue = $5
       where id = $1`,
      [campId, specDate, specVenue, surgDate, surgVenue],
    );
  } else {
    campId = randomUUID();
    await adminClient.query(
      `insert into public.camps (
         id, name, venue, is_active,
         spectacles_collection_date, spectacles_collection_venue,
         post_camp_surgery_date, post_camp_surgery_venue
       ) values ($1, 'Deferral Test Camp', $2, true, $3, $4, $5, $6)`,
      [campId, VENUE, specDate, specVenue, surgDate, surgVenue],
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

  await adminClient.query(
    `insert into public.camp_days (id, camp_id, day_date, seat_limit, theatre_capacity) values ($1, $2, $3, 100, $4)`,
    [dayId, campId, dayDateIso, opts.theatreCapacity ?? 10],
  );

  await adminClient.query(
    `insert into auth.users (id, email) values ($1, $2)`,
    [doctorId, `${doctorId}@deferral.test`],
  );
  await adminClient.query(
    `insert into public.profiles (id, full_name, role) values ($1, 'Test Doctor', 'doctor')`,
    [doctorId],
  );

  await adminClient.query(
    `insert into auth.users (id, email) values ($1, $2)`,
    [adminId, `${adminId}@deferral.test`],
  );
  await adminClient.query(
    `insert into public.profiles (id, full_name, role) values ($1, 'Test Admin', 'admin')`,
    [adminId],
  );

  return { campId, dayId, doctorId, adminId, dayDateIso };
}

async function createWaitingPatient(campId, dayId, regNo, name, phone = "9876543210") {
  const patientId = randomUUID();
  await adminClient.query(
    `insert into public.patients (id, camp_id, camp_day_id, reg_no, full_name, phone, queue_status, gender, age)
     values ($1, $2, $3, $4, $5, $6, 'waiting', 'M', 55)`,
    [patientId, campId, dayId, regNo, name, phone],
  );
  return patientId;
}

describe("Deferral state, snapshot immutability, SMS ledger, and admin lists DB tests", () => {
  test("ticking bifocal creates spectacles order already deferred with snapshot date and venue", async (t) => {
    if (skipIfNoDb(t)) return;

    const { campId, dayId, doctorId } = await seedTestEnvironment({
      spectaclesDate: "2099-10-15",
      spectaclesVenue: "Community Hall, Ward 4",
    });
    const patientId = await createWaitingPatient(campId, dayId, Math.floor(Math.random() * 800000) + 100000, "Bifocal Patient");

    const c = newClient();
    await c.connect();

    try {
      const res = await asAuthenticated(c, doctorId, async () => {
        const { rows } = await c.query(
          `select * from public.doctor_submit_prescription(
             $1::uuid, 'Presbyopia', 'Bilateral', null, 'Use bifocals', 'bifocal', array['spectacles']
           )`,
          [patientId],
        );
        return rows[0];
      });

      assert.equal(res.created_orders_count, 1);

      const { rows: orders } = await adminClient.query(
        `select status, deferred_date::text as deferred_date_str, deferred_venue from public.treatment_orders where patient_id = $1 and kind = 'spectacles'`,
        [patientId],
      );

      assert.equal(orders.length, 1);
      assert.equal(orders[0].status, "deferred", "Bifocal order must be created directly in deferred status");
      assert.equal(orders[0].deferred_date_str, "2099-10-15", "Deferred date snapshot matches camp collection date");
      assert.equal(orders[0].deferred_venue, "Community Hall, Ward 4", "Deferred venue snapshot matches camp collection venue");
    } finally {
      await c.end();
    }
  });

  test("counter volunteer can defer pending spectacles order in one tap (typing no date/venue)", async (t) => {
    if (skipIfNoDb(t)) return;

    const { campId, dayId, doctorId } = await seedTestEnvironment({
      spectaclesDate: "2099-10-15",
      spectaclesVenue: "Community Hall, Ward 4",
    });
    const patientId = await createWaitingPatient(campId, dayId, Math.floor(Math.random() * 800000) + 100000, "Fixed Glasses Patient");

    const c = newClient();
    await c.connect();

    try {
      // Doctor creates pending spectacles order (fixed power)
      await asAuthenticated(c, doctorId, async () => {
        await c.query(
          `select * from public.doctor_submit_prescription(
             $1::uuid, 'Myopia', 'RE -1.50', null, 'Glasses', 'fixed', array['spectacles']
           )`,
          [patientId],
        );
      });

      const { rows: pendingOrders } = await adminClient.query(
        `select id, status from public.treatment_orders where patient_id = $1 and kind = 'spectacles'`,
        [patientId],
      );
      assert.equal(pendingOrders[0].status, "pending");

      // Volunteer defers order at counter with NULL date and NULL venue parameters
      const deferredRes = await asAuthenticated(c, doctorId, async () => {
        const { rows } = await c.query(
          `select id, status, deferred_date::text as deferred_date_str, deferred_venue from public.resolve_treatment_order($1::uuid, 'deferred', null, null)`,
          [pendingOrders[0].id],
        );
        return rows[0];
      });

      assert.equal(deferredRes.status, "deferred");
      assert.equal(deferredRes.deferred_date_str, "2099-10-15");
      assert.equal(deferredRes.deferred_venue, "Community Hall, Ward 4");
    } finally {
      await c.end();
    }
  });

  test("changing administrator collection date afterwards does NOT alter already-deferred order snapshot", async (t) => {
    if (skipIfNoDb(t)) return;

    const { campId, dayId, doctorId } = await seedTestEnvironment({
      spectaclesDate: "2099-10-15",
      spectaclesVenue: "Original Venue",
    });
    const patientId = await createWaitingPatient(campId, dayId, Math.floor(Math.random() * 800000) + 100000, "Immutable Snapshot Patient");

    const c = newClient();
    await c.connect();

    try {
      // Doctor prescribes bifocals -> order deferred with snapshot "2099-10-15" / "Original Venue"
      await asAuthenticated(c, doctorId, async () => {
        await c.query(
          `select * from public.doctor_submit_prescription(
             $1::uuid, 'Diag', 'Exam', null, 'Adv', 'bifocal', array['spectacles']
           )`,
          [patientId],
        );
      });

      // Admin changes camp spectacles_collection_date and venue to next year
      await adminClient.query(
        `update public.camps set spectacles_collection_date = '2100-01-01', spectacles_collection_venue = 'Changed Venue' where id = $1`,
        [campId],
      );

      // Verify order snapshot remains untouched!
      const { rows: orders } = await adminClient.query(
        `select deferred_date::text as deferred_date_str, deferred_venue from public.treatment_orders where patient_id = $1 and kind = 'spectacles'`,
        [patientId],
      );
      assert.equal(orders[0].deferred_date_str, "2099-10-15");
      assert.equal(orders[0].deferred_venue, "Original Venue");
    } finally {
      await c.end();
    }
  });

  test("exhausted theatre creates deferred order snapshotting post-camp surgery date and venue", async (t) => {
    if (skipIfNoDb(t)) return;

    const { campId, dayId, doctorId } = await seedTestEnvironment({
      theatreCapacity: 0, // 0 slots on current day
      surgeryDate: "2099-11-20",
      surgeryVenue: "District Hospital OT, Eye Ward",
    });
    const patientId = await createWaitingPatient(campId, dayId, Math.floor(Math.random() * 800000) + 100000, "Surgery Fallback Patient");

    const c = newClient();
    await c.connect();

    try {
      const res = await asAuthenticated(c, doctorId, async () => {
        const { rows } = await c.query(
          `select * from public.doctor_submit_prescription(
             $1::uuid, 'Cataract', 'Bilateral mature', 'Pre-op drops', 'Surgery required', null, array['ot']
           )`,
          [patientId],
        );
        return rows[0];
      });

      assert.equal(res.created_orders_count, 1);

      const { rows: orders } = await adminClient.query(
        `select status, deferred_date::text as deferred_date_str, deferred_venue from public.treatment_orders where patient_id = $1 and kind = 'ot'`,
        [patientId],
      );

      assert.equal(orders[0].status, "deferred", "OT order must be created deferred when all theatre capacity is exhausted");
      assert.equal(orders[0].deferred_date_str, "2099-11-20", "Snapshot date is post-camp surgery date");
      assert.equal(orders[0].deferred_venue, "District Hospital OT, Eye Ward", "Snapshot venue is post-camp surgery venue");
    } finally {
      await c.end();
    }
  });

  test("refused with structured error when spectacles collection date/venue not configured", async (t) => {
    if (skipIfNoDb(t)) return;

    const { campId, dayId, doctorId } = await seedTestEnvironment({
      spectaclesDate: null,
      spectaclesVenue: null,
    });
    const patientId = await createWaitingPatient(campId, dayId, Math.floor(Math.random() * 800000) + 100000, "Unconfigured Spec Patient");

    const c = newClient();
    await c.connect();

    try {
      let errRes = null;
      try {
        await asAuthenticated(c, doctorId, async () => {
          await c.query(
            `select * from public.doctor_submit_prescription(
               $1::uuid, 'Presbyopia', 'Bilateral', null, 'Bifocals', 'bifocal', array['spectacles']
             )`,
            [patientId],
          );
        });
      } catch (err) {
        errRes = err;
      }

      assert.ok(errRes, "Must throw exception when admin has not configured spectacles collection date/venue");
      assert.match(errRes.message, /Spectacles collection date and venue must be configured by admin/i);
    } finally {
      await c.end();
    }
  });

  test("refused with structured error when post-camp surgery date/venue not configured and theatre is full", async (t) => {
    if (skipIfNoDb(t)) return;

    const { campId, dayId, doctorId } = await seedTestEnvironment({
      theatreCapacity: 0,
      surgeryDate: null,
      surgeryVenue: null,
    });
    const patientId = await createWaitingPatient(campId, dayId, Math.floor(Math.random() * 800000) + 100000, "Unconfigured OT Patient");

    const c = newClient();
    await c.connect();

    try {
      let errRes = null;
      try {
        await asAuthenticated(c, doctorId, async () => {
          await c.query(
            `select * from public.doctor_submit_prescription(
               $1::uuid, 'Cataract', 'Mature', null, 'OT', null, array['ot']
             )`,
            [patientId],
          );
        });
      } catch (err) {
        errRes = err;
      }

      assert.ok(errRes, "Must throw exception when admin has not configured post-camp surgery date/venue");
      assert.match(errRes.message, /Post-camp surgery date and venue must be configured by admin/i);
    } finally {
      await c.end();
    }
  });

  test("pharmacy orders cannot be deferred (enforced at DB level)", async (t) => {
    if (skipIfNoDb(t)) return;

    const { campId, dayId, doctorId } = await seedTestEnvironment({});
    const patientId = await createWaitingPatient(campId, dayId, Math.floor(Math.random() * 800000) + 100000, "Pharmacy Patient");

    const c = newClient();
    await c.connect();

    try {
      await asAuthenticated(c, doctorId, async () => {
        await c.query(
          `select * from public.doctor_submit_prescription(
             $1::uuid, 'Infection', 'Conjunctivitis', 'Antibiotic drops', 'Instill 4x daily', null, array['pharmacy']
           )`,
          [patientId],
        );
      });

      const { rows: orders } = await adminClient.query(
        `select id from public.treatment_orders where patient_id = $1 and kind = 'pharmacy'`,
        [patientId],
      );

      let errRes = null;
      try {
        await asAuthenticated(c, doctorId, async () => {
          await c.query(
            `select * from public.resolve_treatment_order($1::uuid, 'deferred', '2099-10-15', 'Venue')`,
            [orders[0].id],
          );
        });
      } catch (err) {
        errRes = err;
      }

      assert.ok(errRes, "Deferring pharmacy order must be rejected");
      assert.match(errRes.message, /Pharmacy orders cannot be deferred/i);
    } finally {
      await c.end();
    }
  });

  test("admin can list deferred spectacles and deferred surgery orders as separate lists", async (t) => {
    if (skipIfNoDb(t)) return;

    const { campId, dayId, doctorId, adminId } = await seedTestEnvironment({
      theatreCapacity: 0,
      spectaclesDate: "2099-10-15",
      spectaclesVenue: "Spec Venue",
      surgeryDate: "2099-11-20",
      surgeryVenue: "Surgery Venue",
    });

    const p1 = await createWaitingPatient(campId, dayId, 888001, "Spectacles Deferred Patient");
    const p2 = await createWaitingPatient(campId, dayId, 888002, "Surgery Deferred Patient");

    const c = newClient();
    await c.connect();

    try {
      // Patient 1 gets bifocals -> deferred spectacles order
      await asAuthenticated(c, doctorId, async () => {
        await c.query(
          `select * from public.doctor_submit_prescription($1::uuid, 'Diag', 'Exam', null, 'Adv', 'bifocal', array['spectacles'])`,
          [p1],
        );
      });

      // Patient 2 gets surgery with 0 capacity -> deferred OT order
      await asAuthenticated(c, doctorId, async () => {
        await c.query(
          `select * from public.doctor_submit_prescription($1::uuid, 'Diag', 'Exam', null, 'Adv', null, array['ot'])`,
          [p2],
        );
      });

      // Admin lists spectacles deferred orders
      const specList = await asAuthenticated(c, adminId, async () => {
        const { rows } = await c.query(
          `select * from public.admin_list_deferred_orders($1::uuid, 'spectacles')`,
          [campId],
        );
        return rows;
      });

      assert.equal(specList.length, 1);
      assert.equal(specList[0].patient_id, p1);
      assert.equal(specList[0].deferred_venue, "Spec Venue");

      // Admin lists surgery deferred orders
      const surgeryList = await asAuthenticated(c, adminId, async () => {
        const { rows } = await c.query(
          `select * from public.admin_list_deferred_orders($1::uuid, 'ot')`,
          [campId],
        );
        return rows;
      });

      assert.equal(surgeryList.length, 1);
      assert.equal(surgeryList[0].patient_id, p2);
      assert.equal(surgeryList[0].deferred_venue, "Surgery Venue");
    } finally {
      await c.end();
    }
  });

  test("patient deferred on both counts receives TWO distinct sms_deliveries entries", async (t) => {
    if (skipIfNoDb(t)) return;

    const { campId, dayId, doctorId } = await seedTestEnvironment({
      theatreCapacity: 0, // full OT
      spectaclesDate: "2099-10-15",
      spectaclesVenue: "Spec Hall",
      surgeryDate: "2099-11-20",
      surgeryVenue: "Surgery Ward",
    });
    const patientId = await createWaitingPatient(campId, dayId, Math.floor(Math.random() * 800000) + 100000, "Dual Deferred Patient", "9876543210");

    const c = newClient();
    await c.connect();

    try {
      // Doctor prescribes bifocals AND surgery when OT capacity is 0 -> BOTH get deferred!
      await asAuthenticated(c, doctorId, async () => {
        await c.query(
          `select * from public.doctor_submit_prescription(
             $1::uuid, 'Complex', 'Bilateral + Presbyopia', 'Drops', 'Dual care', 'bifocal', array['spectacles', 'ot']
           )`,
          [patientId],
        );
      });

      // Verify sms_deliveries table contains TWO rows for this patient: spectacles_deferral AND surgery_deferral!
      const { rows: smsRows } = await adminClient.query(
        `select kind, state, phone_last4 from public.sms_deliveries where patient_id = $1 order by kind asc`,
        [patientId],
      );

      assert.equal(smsRows.length, 2, "Patient deferred on both counts must have 2 SMS delivery rows");
      const kinds = smsRows.map((r) => r.kind);
      assert.ok(kinds.includes("spectacles_deferral"), "Contains spectacles_deferral SMS entry");
      assert.ok(kinds.includes("surgery_deferral"), "Contains surgery_deferral SMS entry");
      assert.equal(smsRows[0].phone_last4, "3210");
      assert.equal(smsRows[1].phone_last4, "3210");
    } finally {
      await c.end();
    }
  });
});
