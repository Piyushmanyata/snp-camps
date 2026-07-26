/**
 * Empirical Stress Test Harness for #58 (QR Camera Session & Orchestrator)
 * and #57 (doctor_assign_patient state machine).
 * 
 * Written by Challenger M1-1 for empirical verification.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { QrCameraSession } from "../src/lib/qr-camera-session.ts";
import { QrDecodeOrchestrator } from "../src/lib/qr-decode-orchestrator.ts";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const VENUE = "empirical-challenge-test";

function createFakeStream(id) {
  const stopped = { count: 0 };
  const tracks = [
    {
      id: `${id}-track1`,
      stop() {
        stopped.count += 1;
      },
    },
    {
      id: `${id}-track2`,
      stop() {
        stopped.count += 1;
      },
    },
  ];
  return {
    id,
    stopped,
    getTracks() {
      return tracks;
    },
  };
}

// --------------------------------------------------------------------------
// SECTION 1: EMPIRICAL STRESS TESTS FOR QR CAMERA SESSION & ORCHESTRATOR (#58)
// --------------------------------------------------------------------------

test("STRESS: Rapid start/stop/unmount cycles & delayed acquire out-of-order resolution", async () => {
  const session = new QrCameraSession();
  const createdStreams = [];

  // Run 100 rapid cycles of begin / acquire / invalidate with delayed getUserMedia
  const acquirePromises = [];

  for (let i = 0; i < 100; i++) {
    const token = session.begin();
    const stream = createFakeStream(`stream-${i}`);
    createdStreams.push(stream);

    // Artificial random delay between 0 and 15ms before getUserMedia resolves
    const delay = Math.floor(Math.random() * 15);
    const getUserMedia = () =>
      new Promise((resolve) => {
        setTimeout(() => resolve(stream), delay);
      });

    const p = session.acquire(token, getUserMedia, { video: true });
    acquirePromises.push(p);

    if (i % 3 === 0) {
      session.invalidate();
    }
    if (i % 7 === 0) {
      session.begin();
    }
  }

  const results = await Promise.all(acquirePromises);

  // Verification:
  // 1. Only at most ONE result can be non-null (the current active session stream).
  const activeResults = results.filter((r) => r !== null);
  assert.ok(
    activeResults.length <= 1,
    `Expected at most 1 active stream, got ${activeResults.length}`,
  );

  if (activeResults.length === 1) {
    assert.equal(session.mediaStream, activeResults[0]);
  } else {
    assert.equal(session.mediaStream, null);
  }

  // 2. All streams that were rejected/superseded must have stopped tracks (stopped.count > 0).
  for (const stream of createdStreams) {
    if (stream !== session.mediaStream) {
      assert.ok(
        stream.stopped.count > 0,
        `Stream ${stream.id} was abandoned but tracks were not stopped!`,
      );
    }
  }
});

test("STRESS: getUserMedia failure / rejection does not crash session or leak state", async () => {
  const session = new QrCameraSession();
  const token = session.begin();

  const getUserMedia = () =>
    Promise.reject(new Error("NotAllowedError: Permission denied"));

  const stream = await session.acquire(token, getUserMedia, { video: true });
  assert.equal(stream, null);
  assert.equal(session.mediaStream, null);
  assert.equal(session.isCurrent(token), true);
});

test("STRESS: Orchestrator high-frequency state flapping & error handling during native detect", async () => {
  const session = new QrCameraSession();
  const token = session.begin();
  const decoded = [];

  const orch = new QrDecodeOrchestrator({
    isLive: () => session.isCurrent(token),
    onDecoded: (raw) => decoded.push(raw),
  });

  // Test 1: Native detect throwing an error should not leave inFlight = true
  const throwingDetect = async () => {
    throw new Error("Native BarcodeDetector internal error");
  };

  await assert.rejects(
    async () => {
      await orch.runNativeDetect({} /* mock source */, throwingDetect);
    },
    /Native BarcodeDetector internal error/,
  );

  // Verify orchestrator recovers and shouldRunFrame is true again
  assert.equal(orch.shouldRunFrame(), true);

  // Test 2: Rapid state flapping while detect is in-flight
  let resolveDetect;
  const slowDetectPromise = new Promise((resolve) => {
    resolveDetect = resolve;
  });

  const detectCall = orch.runNativeDetect(
    {},
    async () => slowDetectPromise,
  );

  // Flap states while in-flight
  orch.pause();
  orch.resume();
  orch.freeze();
  orch.unfreeze();

  // Resolve after session invalidation
  session.invalidate();
  resolveDetect([{ rawValue: "snp:patient-stale" }]);

  const fired = await detectCall;
  assert.equal(fired, false);
  assert.deepEqual(decoded, []);
});

test("STRESS: Synchronous decode under invalidation and freeze", () => {
  const session = new QrCameraSession();
  const token = session.begin();
  const decoded = [];

  const orch = new QrDecodeOrchestrator({
    isLive: () => session.isCurrent(token),
    onDecoded: (raw) => decoded.push(raw),
  });

  assert.equal(orch.runSyncDecode("snp:valid-qr"), true);
  assert.deepEqual(decoded, ["snp:valid-qr"]);

  session.invalidate();
  assert.equal(orch.runSyncDecode("snp:stale-qr"), false);
  assert.deepEqual(decoded, ["snp:valid-qr"]);
});


// --------------------------------------------------------------------------
// SECTION 2: EMPIRICAL STRESS TESTS FOR doctor_assign_patient RPC (#57)
// --------------------------------------------------------------------------

/** @type {pg.Client | null} */
let client = null;
let dbAvailable = false;

async function connectDb() {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await c.connect();
    const { rows } = await c.query(
      `select to_regprocedure('public.assign_patient_doctor(uuid,integer,uuid)') is not null as ok`,
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
  client = await connectDb();
  dbAvailable = Boolean(client);
  if (!dbAvailable) {
    console.warn(
      "[empirical-challenge] local Postgres unavailable — DB stress tests skipped",
    );
  }
});

test.after(async () => {
  if (client) {
    try {
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
        `delete from public.profiles where email like '%@empirical-challenge.test'`,
      );
      await client.query(
        `delete from auth.users where email like '%@empirical-challenge.test'`,
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

async function seedProfile(role) {
  const userId = randomUUID();
  const email = `${role}-${userId.slice(0, 8)}@empirical-challenge.test`;
  await client.query(
    `insert into auth.users (
       id, instance_id, aud, role, email,
       encrypted_password, email_confirmed_at,
       raw_app_meta_data, raw_user_meta_data,
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
       now(), now()
     )`,
    [userId, email],
  );
  await client.query(
    `insert into public.profiles (id, role, full_name, email)
     values ($1, $2, $3, $4)
     on conflict (id) do update set role = excluded.role, disabled_at = null`,
    [userId, role, `Empirical ${role}`, email],
  );
  return userId;
}

async function seedCampFutureDay() {
  const campId = randomUUID();
  const dayId = randomUUID();
  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock(918273646)");
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
      `update public.camps set is_active = false where is_active = true`,
    );
    await client.query(
      `insert into public.camps (id, name, is_active, venue)
       values ($1, $2, true, $3)`,
      [campId, `Empirical ${campId.slice(0, 8)}`, VENUE],
    );
    await client.query(
      `insert into public.camp_days (id, camp_id, day_date, seat_limit)
       values ($1, $2, '2099-08-20', 100)`,
      [dayId, campId],
    );
    await client.query("commit");
    return { campId, dayId };
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

async function registerPatient(campId, dayId, name) {
  return asServiceRole(async () => {
    const { rows } = await client.query(
      `select * from public.register_patient_idempotent(
         $1, $2, $3, 'M', 45, 'Ward B', null, null, null,
         null, null, $4, false, false
       )`,
      [randomUUID(), campId, name, dayId],
    );
    return rows[0];
  });
}

test("STRESS: High-concurrency assignment burst across registered vs waiting patients", async (t) => {
  if (skipIfNoDb(t)) return;

  const doc1 = await seedProfile("doctor");
  const doc2 = await seedProfile("doctor");
  const doc3 = await seedProfile("doctor");
  const vol1 = await seedProfile("volunteer");

  const { campId, dayId } = await seedCampFutureDay();

  // Create 10 patients
  const patients = [];
  for (let i = 0; i < 10; i++) {
    const p = await registerPatient(campId, dayId, `Burst Patient ${i}`);
    patients.push(p);
  }

  // Check in patients 0..4 so they are 'waiting'
  for (let i = 0; i < 5; i++) {
    const pId = patients[i].id;
    await client.query("begin");
    await client.query(
      `select set_config('request.jwt.claim.role', 'authenticated', true)`,
    );
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      vol1,
    ]);
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ role: "authenticated", sub: vol1 }),
    ]);
    await client.query(`set local role authenticated`);
    await client.query(`select * from public.check_in_patient($1, null)`, [pId]);
    await client.query("commit");
  }

  // Now, fire 30 concurrent doctor assignment calls (3 doctors x 10 patients)
  async function callAssign(doctorId, patientId) {
    const c = new pg.Client({ connectionString: DATABASE_URL });
    await c.connect();
    try {
      await c.query("begin");
      await c.query(
        `select set_config('request.jwt.claim.role', 'authenticated', true)`,
      );
      await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
        doctorId,
      ]);
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ role: "authenticated", sub: doctorId }),
      ]);
      await c.query(`set local role authenticated`);
      const { rows } = await c.query(
        `select * from public.assign_patient_doctor($1, null, null)`,
        [patientId],
      );
      await c.query("commit");
      return { patientId, doctorId, result: rows[0] };
    } catch (err) {
      await c.query("rollback").catch(() => {});
      return { patientId, doctorId, error: err };
    } finally {
      await c.end().catch(() => {});
    }
  }

  const doctors = [doc1, doc2, doc3];
  const promises = [];

  for (const p of patients) {
    for (const d of doctors) {
      promises.push(callAssign(d, p.id));
    }
  }

  const assignResults = await Promise.all(promises);

  // Group by patient
  for (let i = 0; i < 10; i++) {
    const pId = patients[i].id;
    const pResults = assignResults.filter((r) => r.patientId === pId);

    if (i < 5) {
      // Patients 0..4 were 'waiting'.
      // EXACTLY 1 request should succeed (error_code null, queue_status seen, already_seen false).
      // The other 2 requests MUST be 'already_seen' (error_code already_seen, already_seen true, doctor_id = winner doctor_id).
      const successes = pResults.filter(
        (r) => r.result?.error_code === null && r.result?.queue_status === "seen",
      );
      const alreadySeens = pResults.filter(
        (r) => r.result?.error_code === "already_seen",
      );

      assert.equal(
        successes.length,
        1,
        `Patient ${i} (waiting) should have exactly 1 successful assignment, got ${successes.length}`,
      );
      assert.equal(
        alreadySeens.length,
        2,
        `Patient ${i} (waiting) should have 2 already_seen responses, got ${alreadySeens.length}`,
      );

      const winningDoctor = successes[0].result.doctor_id;
      for (const als of alreadySeens) {
        assert.equal(
          als.result.doctor_id,
          winningDoctor,
          `Patient ${i} already_seen returned doctor_id ${als.result.doctor_id} instead of winner ${winningDoctor}`,
        );
      }
    } else {
      // Patients 5..9 were 'registered' (not checked in).
      // ALL 3 requests MUST return error_code check_in_required!
      for (const r of pResults) {
        assert.equal(
          r.result?.error_code,
          "check_in_required",
          `Patient ${i} (registered) should return check_in_required`,
        );
        assert.equal(r.result?.queue_status, "registered");
        assert.equal(r.result?.already_seen, false);
      }
    }
  }

  // Final DB check for patient statuses
  for (let i = 0; i < 10; i++) {
    const pId = patients[i].id;
    const { rows } = await client.query(
      `select queue_status from public.patients where id = $1`,
      [pId],
    );
    const expectedStatus = i < 5 ? "seen" : "registered";
    assert.equal(
      rows[0].queue_status,
      expectedStatus,
      `Patient ${i} final queue_status mismatch`,
    );
  }
});

test("STRESS: Invalid roles, disabled doctor, and inactive camp exception checks", async (t) => {
  if (skipIfNoDb(t)) return;

  const docId = await seedProfile("doctor");
  const volId = await seedProfile("volunteer");
  const { campId, dayId } = await seedCampFutureDay();
  const patient = await registerPatient(campId, dayId, "Error Check Patient");

  // Check in patient so queue_status is 'waiting'
  await client.query("begin");
  await client.query(`select set_config('request.jwt.claim.role', 'authenticated', true)`);
  await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [volId]);
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ role: "authenticated", sub: volId }),
  ]);
  await client.query(`set local role authenticated`);
  await client.query(`select * from public.check_in_patient($1, null)`, [patient.id]);
  await client.query("commit");

  // Test 1: Volunteer calling assign without p_doctor_id -> returns doctor_required error_code
  await client.query("begin");
  await client.query(`select set_config('request.jwt.claim.role', 'authenticated', true)`);
  await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [volId]);
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ role: "authenticated", sub: volId }),
  ]);
  await client.query(`set local role authenticated`);
  const { rows: reqDocRows } = await client.query(
    `select * from public.assign_patient_doctor($1, null, null)`,
    [patient.id],
  );
  await client.query("commit");
  assert.equal(reqDocRows[0].error_code, "doctor_required");

  // Test 2: Volunteer passing a non-existent or disabled doctor ID -> raises exception
  const fakeDocId = randomUUID();
  await assert.rejects(
    async () => {
      try {
        await client.query("begin");
        await client.query(`select set_config('request.jwt.claim.role', 'authenticated', true)`);
        await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [volId]);
        await client.query(`select set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ role: "authenticated", sub: volId }),
        ]);
        await client.query(`set local role authenticated`);
        await client.query(
          `select * from public.assign_patient_doctor($1, null, $2)`,
          [patient.id, fakeDocId],
        );
        await client.query("commit");
      } catch (err) {
        await client.query("rollback").catch(() => {});
        throw err;
      }
    },
    /Invalid or disabled doctor/,
  );

  // Test 3: Inactive camp exception
  await client.query(`update public.camps set is_active = false where id = $1`, [campId]);

  await assert.rejects(
    async () => {
      try {
        await client.query("begin");
        await client.query(`select set_config('request.jwt.claim.role', 'authenticated', true)`);
        await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [docId]);
        await client.query(`select set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ role: "authenticated", sub: docId }),
        ]);
        await client.query(`set local role authenticated`);
        await client.query(
          `select * from public.assign_patient_doctor($1, null, null)`,
          [patient.id],
        );
        await client.query("commit");
      } catch (err) {
        await client.query("rollback").catch(() => {});
        throw err;
      }
    },
    /Patient belongs to an inactive camp/,
  );
});
