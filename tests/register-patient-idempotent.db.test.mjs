/**
 * Real-database coverage for register_patient_idempotent (#19).
 * Requires local Supabase Postgres (default 127.0.0.1:54322).
 *
 * - Null camp_day replay must return the original row (left join fix).
 * - Concurrent N>M registrations: exactly M successes.
 * - change_camp_day cannot overbook under concurrency.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/** @type {pg.Client | null} */
let client = null;
let dbAvailable = false;

async function connect() {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await c.connect();
    const { rows } = await c.query(
      `select to_regprocedure(
         'public.register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean)'
       ) is not null as ok`,
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
      "[register-patient-idempotent.db] local Postgres unavailable — DB tests skipped",
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

/** Run as service_role so the SECURITY DEFINER function accepts the call. */
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

async function seedCampWithDay({ seatLimit = 10, dayDate = "2099-01-15" } = {}) {
  const campId = randomUUID();
  const dayId = randomUUID();
  // Only one active camp is allowed (camps_one_active). Claim the slot.
  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock(918273645)");
    await client.query(
      `update public.camps set is_active = false where is_active = true`,
    );
    await client.query(
      `insert into public.camps (id, name, is_active, venue)
       values ($1, $2, true, 'db-test')`,
      [campId, `DB test camp ${campId.slice(0, 8)}`],
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

test("replay with null camp_day returns the original registration", async (t) => {
  if (skipIfNoDb(t)) return;

  const campId = randomUUID();
  const requestId = randomUUID();
  const patientId = randomUUID();

  await client.query(
    `insert into public.camps (id, name, is_active, venue)
     values ($1, $2, true, 'db-test')`,
    [campId, `Null-day camp ${campId.slice(0, 8)}`],
  );

  // Legitimate state: registered before a day is assigned (null camp_day_id).
  await client.query(
    `insert into public.patients (
       id, registration_request_id, camp_id, camp_day_id,
       full_name, queue_status, phone
     ) values ($1, $2, $3, null, 'Null Day Patient', 'registered', '9000000001')`,
    [patientId, requestId, campId],
  );

  try {
    const { rows } = await asServiceRole(() =>
      client.query(
        `select id, reg_no, full_name, camp_day_id, day_date
         from public.register_patient_idempotent(
           $1::uuid, $2::uuid, 'Null Day Patient',
           null, null, null, '9000000001', null, null,
           null, null, null
         )`,
        [requestId, campId],
      ),
    );

    assert.equal(rows.length, 1, "replay must return exactly one row");
    assert.equal(rows[0].id, patientId);
    assert.equal(rows[0].full_name, "Null Day Patient");
    assert.equal(rows[0].camp_day_id, null);
    assert.equal(rows[0].day_date, null);

    const { rows: countRows } = await client.query(
      `select count(*)::int as n from public.patients
       where registration_request_id = $1`,
      [requestId],
    );
    assert.equal(countRows[0].n, 1, "must not insert a second patient");
  } finally {
    await cleanupCamp(campId);
  }
});

test("N concurrent registrations against M seats yield exactly M successes", async (t) => {
  if (skipIfNoDb(t)) return;

  const M = 3;
  const N = 8;
  const { campId, dayId } = await seedCampWithDay({
    seatLimit: M,
    dayDate: "2099-02-01",
  });

  try {
    const jobs = Array.from({ length: N }, (_, i) => {
      const requestId = randomUUID();
      return (async () => {
        const c = new pg.Client({ connectionString: DATABASE_URL });
        await c.connect();
        try {
          await c.query("begin");
          await c.query(
            `select set_config('request.jwt.claim.role', 'service_role', true)`,
          );
          try {
            const { rows } = await c.query(
              `select id, reg_no from public.register_patient_idempotent(
                 $1::uuid, $2::uuid, $3::text,
                 'M', 30, null, null, null, null,
                 null, null, $4::uuid
               )`,
              [requestId, campId, `Concurrent ${i}`, dayId],
            );
            await c.query("commit");
            return { ok: true, id: rows[0]?.id };
          } catch (err) {
            await c.query("rollback");
            return { ok: false, message: String(err.message || err) };
          }
        } finally {
          await c.end();
        }
      })();
    });

    const results = await Promise.all(jobs);
    const successes = results.filter((r) => r.ok);
    const failures = results.filter((r) => !r.ok);

    assert.equal(
      successes.length,
      M,
      `expected ${M} successes, got ${successes.length}: ${JSON.stringify(results)}`,
    );
    assert.equal(failures.length, N - M);
    for (const f of failures) {
      assert.match(f.message, /full|seat/i, f.message);
    }

    const { rows: taken } = await client.query(
      `select count(*)::int as n from public.patients where camp_day_id = $1`,
      [dayId],
    );
    assert.equal(taken[0].n, M);
  } finally {
    await cleanupCamp(campId);
  }
});

test("concurrent change_camp_day cannot overbook a full day", async (t) => {
  if (skipIfNoDb(t)) return;

  // One seat free (limit 2, one occupant) so exactly one of two concurrent
  // movers may succeed; the other must hit the seat-full path under the lock.
  const { campId, dayId: targetDayId } = await seedCampWithDay({
    seatLimit: 2,
    dayDate: "2099-03-01",
  });
  const sourceDayId = randomUUID();
  await client.query(
    `insert into public.camp_days (id, camp_id, day_date, seat_limit)
     values ($1, $2, '2099-03-02'::date, 50)`,
    [sourceDayId, campId],
  );

  // Staff actor for is_staff() (auth.uid → profiles.role admin|volunteer).
  const staffId = randomUUID();
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
       crypt('test-pass-not-used', gen_salt('bf')),
       now(),
       '{"provider":"email","providers":["email"]}'::jsonb,
       '{}'::jsonb,
       now(), now()
     )`,
    [staffId, `staff-${staffId.slice(0, 8)}@test.local`],
  );
  await client.query(
    `insert into public.profiles (id, role, full_name, email)
     values ($1, 'volunteer', 'DB Test Staff', $2)
     on conflict (id) do update set role = excluded.role, disabled_at = null`,
    [staffId, `staff-${staffId.slice(0, 8)}@test.local`],
  );

  // Fill the target day to capacity.
  await client.query(
    `insert into public.patients (camp_id, camp_day_id, full_name, queue_status)
     values ($1, $2, 'Seat Holder', 'registered')`,
    [campId, targetDayId],
  );

  const moverA = randomUUID();
  const moverB = randomUUID();
  await client.query(
    `insert into public.patients (id, camp_id, camp_day_id, full_name, queue_status)
     values
       ($1, $3, $4, 'Mover A', 'registered'),
       ($2, $3, $4, 'Mover B', 'registered')`,
    [moverA, moverB, campId, sourceDayId],
  );

  try {
    const move = async (patientId) => {
      const c = new pg.Client({ connectionString: DATABASE_URL });
      await c.connect();
      try {
        await c.query("begin");
        await c.query(
          `select set_config('request.jwt.claim.role', 'authenticated', true)`,
        );
        await c.query(
          `select set_config('request.jwt.claim.sub', $1, true)`,
          [staffId],
        );
        try {
          const { rows } = await c.query(
            `select id from public.change_camp_day($1::uuid, $2::uuid)`,
            [patientId, targetDayId],
          );
          await c.query("commit");
          return { ok: true, id: rows[0]?.id };
        } catch (err) {
          await c.query("rollback");
          return { ok: false, message: String(err.message || err) };
        }
      } finally {
        await c.end();
      }
    };

    const results = await Promise.all([move(moverA), move(moverB)]);
    const successes = results.filter((r) => r.ok);
    const failures = results.filter((r) => !r.ok);

    assert.equal(
      successes.length,
      1,
      `expected exactly 1 successful change_day, got ${JSON.stringify(results)}`,
    );
    assert.equal(failures.length, 1);
    assert.match(failures[0].message, /full|seat/i, failures[0].message);

    const { rows: onTarget } = await client.query(
      `select count(*)::int as n from public.patients where camp_day_id = $1`,
      [targetDayId],
    );
    assert.equal(onTarget[0].n, 2); // seat holder + one mover
  } finally {
    await cleanupCamp(campId);
    await client.query(`delete from public.profiles where id = $1`, [staffId]);
    await client.query(`delete from auth.users where id = $1`, [staffId]);
  }
});

test("register_patient wrapper is gone from the catalog", async (t) => {
  if (skipIfNoDb(t)) return;

  const { rows } = await client.query(
    `select to_regprocedure(
       'public.register_patient(uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid)'
     ) is null as dropped`,
  );
  assert.equal(
    rows[0].dropped,
    true,
    "register_patient(…) must be dropped (non-idempotent wrapper)",
  );
});
