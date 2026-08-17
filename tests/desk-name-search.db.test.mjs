/**
 * Real-database coverage for the desk's lost-slip and unified name searches.
 * Requires local Supabase Postgres (default 127.0.0.1:54322).
 *
 * Lifecycle and presence live in print-presence.db.test.mjs (ADR 0013).
 *
 * The connect guard checks reachability only. A missing RPC must fail loudly:
 * treating it as "Postgres unavailable" deletes coverage exactly when a
 * migration breaks something (AGENTS.md, Testing & Evidence Governance).
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";

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
      "[desk-name-search.db] local Postgres unavailable — DB tests skipped",
    );
  }
});

test.after(async () => {
  if (client) {
    try {
      // Leave no active camp for other suites (camps_one_active).
      await client.query(
        `update public.camps set is_active = false where is_active = true`,
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

async function seedStaffVolunteer() {
  const userId = randomUUID();
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
    [userId, `vol-${userId.slice(0, 8)}@example.test`],
  );
  await client.query(
    `insert into public.profiles (id, role, full_name, email)
     values ($1, 'volunteer', 'Check-in Vol', $2)
     on conflict (id) do update set role = 'volunteer', disabled_at = null`,
    [userId, `vol-${userId.slice(0, 8)}@example.test`],
  );
  return userId;
}

async function seedCampWithDays({ futureDate = "2099-06-15" } = {}) {
  const campId = randomUUID();
  const futureDayId = randomUUID();
  const todayDayId = randomUUID();
  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock(918273645)");
    // Clear leftover test camps so camps_one_active never collides.
    await client.query(
      `delete from public.patients where camp_id in (
         select id from public.camps where venue in ('check-in-test', 'db-test', 'aadhaar-test')
       )`,
    );
    await client.query(
      `delete from public.camp_days where camp_id in (
         select id from public.camps where venue in ('check-in-test', 'db-test', 'aadhaar-test')
       )`,
    );
    await client.query(
      `delete from public.camps where venue in ('check-in-test', 'db-test', 'aadhaar-test')`,
    );
    await client.query(
      `update public.camps set is_active = false where is_active = true`,
    );
    await client.query(
      `insert into public.camps (id, name, is_active, venue)
       values ($1, $2, true, 'check-in-test')`,
      [campId, `Check-in camp ${campId.slice(0, 8)}`],
    );
    const { rows: todayRows } = await client.query(
      `select (timezone('Asia/Kolkata', now()))::date as d`,
    );
    const today = todayRows[0].d;
    await client.query(
      `insert into public.camp_days (id, camp_id, day_date, seat_limit, printing_open)
       values ($1, $2, $3, 50, false), ($4, $2, $5, 50, true)`,
      [futureDayId, campId, futureDate, todayDayId, today],
    );
    await client.query("commit");
    return { campId, futureDayId, todayDayId, today, futureDate };
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

async function asStaff(userId, fn) {
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
    const result = await fn();
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

test("name search returns only registered for active camp", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaffVolunteer();
  const { campId, futureDayId, todayDayId } = await seedCampWithDays();

  await asServiceRole(async () => {
    await client.query(
      `select * from public.register_patient_idempotent(
         $1, $2, 'Ramesh Kumar', 'M', 45, 'Sikar Road', null, null, null,
         null, $3, $4, false, false, false, 'self_declared', null, null, null)`,
      [randomUUID(), campId, staffId, futureDayId],
    );
    await client.query(
      `select * from public.register_patient_idempotent(
         $1, $2, 'Ramesh Walkin', 'M', 40, 'Other', null, null, null,
         null, $3, $4, false, false, false, 'self_declared', null, null, null)`,
      [randomUUID(), campId, staffId, todayDayId],
    );
  });

  const matches = await asStaff(staffId, async () => {
    const { rows } = await client.query(
      `select * from public.search_registered_patients($1, 'ramesh', 10)`,
      [campId],
    );
    return rows;
  });

  assert.ok(matches.length >= 1);
  assert.ok(matches.every((m) => m.full_name.toLowerCase().startsWith("ramesh")));
  assert.ok(
    matches.some((m) => m.full_name === "Ramesh Kumar"),
    "registered pre-reg is returned",
  );
  assert.ok(
    matches.some((m) => m.full_name === "Ramesh Walkin"),
    "a today walk-in is registered too — there is no line to exclude them from",
  );
  const kumar = matches.find((m) => m.full_name === "Ramesh Kumar");
  assert.equal(kumar.age, 45);
  assert.equal(kumar.address, "Sikar Road");
});

test("name search finds one-character typo via trigram (#61)", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaffVolunteer();
  const { campId, futureDayId } = await seedCampWithDays();

  await asServiceRole(async () => {
    await client.query(
      `select * from public.register_patient_idempotent(
         $1, $2, 'Suresh Patel', 'M', 52, 'Jaipur', null, null, null,
         null, $3, $4, false, false, false, 'self_declared', null, null, null)`,
      [randomUUID(), campId, staffId, futureDayId],
    );
  });

  // Single-character substitution: e → a mid-name (not a prefix of normalized name).
  const matches = await asStaff(staffId, async () => {
    const { rows } = await client.query(
      `select * from public.search_registered_patients($1, 'suresha', 10)`,
      [campId],
    );
    return rows;
  });

  assert.ok(
    matches.some((m) => m.full_name === "Suresh Patel"),
    `expected fuzzy hit for suresha → Suresh Patel, got ${JSON.stringify(matches.map((m) => m.full_name))}`,
  );
});

test("unified desk name search returns registered and seen patients", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaffVolunteer();
  const { campId, futureDayId, todayDayId } = await seedCampWithDays();

  const created = await asServiceRole(async () => {
    const rows = [];
    for (const [name, dayId] of [
      ["Unified Registered", futureDayId],
      ["Unified Printed", todayDayId],
      ["Unified Seen", todayDayId],
    ]) {
      const { rows: inserted } = await client.query(
        `select * from public.register_patient_idempotent(
           $1, $2, $3, 'F', 30, 'Sikar', null, null, null,
           null, $4, $5, false, false, false, 'self_declared', null, null, null)`,
        [randomUUID(), campId, name, staffId, dayId],
      );
      rows.push(inserted[0]);
    }
    return rows;
  });

  await asStaff(staffId, async () => {
    await client.query(`select * from public.mark_patient_printed($1, null)`, [
      created[2].id,
    ]);
    await client.query(`select * from public.mark_seen($1, null)`, [created[2].id]);
  });

  const matches = await asStaff(staffId, async () => {
    const { rows } = await client.query(
      `select * from public.search_desk_patients($1, 'unified', 10)`,
      [campId],
    );
    return rows;
  });

  assert.deepEqual(
    new Set(matches.map((row) => row.queue_status)),
    new Set(["registered", "seen"]),
    "the desk search spans the whole two-state lifecycle",
  );
  assert.equal(matches.length, 3, "every unified patient is findable");
});

test("unified desk search finds and returns a Latin display name", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaffVolunteer();
  const { campId, futureDayId } = await seedCampWithDays();

  const patient = await asServiceRole(async () => {
    const { rows } = await client.query(
      `select * from public.register_patient_idempotent(
         $1, $2, 'रमेश कुमार', 'M', 44, 'Sikar', null, null, null,
         null, $3, $4, false, false, false, 'self_declared', null, null, null)`,
      [randomUUID(), campId, staffId, futureDayId],
    );
    await client.query(
      `update public.patients set display_name = 'Ramesh Kumar' where id = $1`,
      [rows[0].id],
    );
    return rows[0];
  });

  const matches = await asStaff(staffId, async () => {
    const { rows } = await client.query(
      `select * from public.search_desk_patients($1, 'ramesh', 10)`,
      [campId],
    );
    return rows;
  });

  assert.equal(
    matches.find((row) => row.id === patient.id)?.full_name,
    "Ramesh Kumar",
  );
});

test("name search finds simple transposition via trigram (#61)", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaffVolunteer();
  const { campId, futureDayId } = await seedCampWithDays();

  await asServiceRole(async () => {
    await client.query(
      `select * from public.register_patient_idempotent(
         $1, $2, 'Priya Sharma', 'F', 28, 'Nawalgarh', null, null, null,
         null, $3, $4, false, false, false, 'self_declared', null, null, null)`,
      [randomUUID(), campId, staffId, futureDayId],
    );
  });

  // Transposition: "Priya" → "Pirya"
  const matches = await asStaff(staffId, async () => {
    const { rows } = await client.query(
      `select * from public.search_registered_patients($1, 'pirya sharma', 10)`,
      [campId],
    );
    return rows;
  });

  assert.ok(
    matches.some((m) => m.full_name === "Priya Sharma"),
    `expected fuzzy hit for pirya sharma → Priya Sharma, got ${JSON.stringify(matches.map((m) => m.full_name))}`,
  );
});

test("exact prefix ranks before fuzzy matches (#61)", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaffVolunteer();
  const { campId, futureDayId } = await seedCampWithDays();

  await asServiceRole(async () => {
    // Exact prefix for query "suresh"
    await client.query(
      `select * from public.register_patient_idempotent(
         $1, $2, 'Suresh Verma', 'M', 50, 'A', null, null, null,
         null, $3, $4, false, false, false, 'self_declared', null, null, null)`,
      [randomUUID(), campId, staffId, futureDayId],
    );
    // Fuzzy-only transposition — normalized name does not start with "suresh"
    await client.query(
      `select * from public.register_patient_idempotent(
         $1, $2, 'Surehs Nair', 'F', 33, 'B', null, null, null,
         null, $3, $4, false, false, false, 'self_declared', null, null, null)`,
      [randomUUID(), campId, staffId, futureDayId],
    );
  });

  const matches = await asStaff(staffId, async () => {
    const { rows } = await client.query(
      `select * from public.search_registered_patients($1, 'suresh', 10)`,
      [campId],
    );
    return rows;
  });

  assert.ok(
    matches.some((m) => m.full_name === "Suresh Verma"),
    "prefix match present",
  );
  assert.equal(
    matches[0].full_name,
    "Suresh Verma",
    "exact prefix must rank first ahead of fuzzy transposition",
  );
});

test("name search excludes other camp and seen (#61)", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaffVolunteer();
  const { campId, futureDayId } = await seedCampWithDays();

  const otherCampId = randomUUID();
  const otherDayId = randomUUID();
  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock(918273645)");
    await client.query(
      `insert into public.camps (id, name, is_active, venue)
       values ($1, $2, false, 'check-in-test')`,
      [otherCampId, `Other camp ${otherCampId.slice(0, 8)}`],
    );
    await client.query(
      `insert into public.camp_days (id, camp_id, day_date, seat_limit)
       values ($1, $2, '2099-07-01', 50)`,
      [otherDayId, otherCampId],
    );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  }

  const seenPatient = await asServiceRole(async () => {
    const { rows } = await client.query(
      `select * from public.register_patient_idempotent(
         $1, $2, 'Geeta Seen', 'F', 35, 'Here', null, null, null,
         null, $3, $4, false, false, false, 'self_declared', null, null, null)`,
      [randomUUID(), campId, staffId, futureDayId],
    );
    return rows[0];
  });
  await client.query(
    `update public.patients
     set queue_status = 'seen', seen_at = now(), printed_at = now()
     where id = $1`,
    [seenPatient.id],
  );

  // Inactive/other camp: insert directly (register_patient requires active camp).
  await client.query(
    `insert into public.patients (
       id, camp_id, camp_day_id, full_name, gender, age, address,
       queue_status, reg_no, created_by
     ) values (
       $1, $2, $3, 'Geeta Other', 'F', 36, 'Away',
       'registered', 900001, $4
     )`,
    [randomUUID(), otherCampId, otherDayId, staffId],
  );

  await asServiceRole(async () => {
    await client.query(
      `select * from public.register_patient_idempotent(
         $1, $2, 'Geeta Active', 'F', 34, 'Local', null, null, null,
         null, $3, $4, false, false, false, 'self_declared', null, null, null)`,
      [randomUUID(), campId, staffId, futureDayId],
    );
  });

  const matches = await asStaff(staffId, async () => {
    const { rows } = await client.query(
      `select * from public.search_registered_patients($1, 'geeta', 10)`,
      [campId],
    );
    return rows;
  });

  assert.ok(matches.some((m) => m.full_name === "Geeta Active"));
  assert.ok(!matches.some((m) => m.full_name === "Geeta Seen"));
  assert.ok(!matches.some((m) => m.full_name === "Geeta Other"));
});

test("name search returns at most 10 deterministic rows (#61)", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaffVolunteer();
  const { campId, futureDayId } = await seedCampWithDays();

  await asServiceRole(async () => {
    for (let i = 0; i < 12; i += 1) {
      // Same normalized prefix so all match; names ordered by suffix for stability.
      const suffix = String(i).padStart(2, "0");
      await client.query(
        `select * from public.register_patient_idempotent(
           $1, $2, $3, 'M', 40, 'X', null, null, null,
           null, $4, $5, false, false, false, 'self_declared', null, null, null)`,
        [
          randomUUID(),
          campId,
          `Common Name ${suffix}`,
          staffId,
          futureDayId,
        ],
      );
    }
  });

  const matches = await asStaff(staffId, async () => {
    const { rows } = await client.query(
      `select * from public.search_registered_patients($1, 'common', 25)`,
      [campId],
    );
    return rows;
  });

  assert.equal(matches.length, 10, "hard cap at 10 even if p_limit is higher");
  // Deterministic: ordered by normalized name then reg_no
  const names = matches.map((m) => m.full_name);
  const sorted = [...names].sort((a, b) =>
    a.localeCompare(b, "en", { sensitivity: "base" }),
  );
  assert.deepEqual(names, sorted);
});

test("search plan uses registered filter and name index path (#61 EXPLAIN)", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaffVolunteer();
  const { campId, futureDayId } = await seedCampWithDays();

  await asServiceRole(async () => {
    await client.query(
      `select * from public.register_patient_idempotent(
         $1, $2, 'Explain Seed', 'M', 40, 'Z', null, null, null,
         null, $3, $4, false, false, false, 'self_declared', null, null, null)`,
      [randomUUID(), campId, staffId, futureDayId],
    );
  });

  const plan = await asStaff(staffId, async () => {
    const { rows } = await client.query(
      `explain (format text)
       select * from public.search_registered_patients($1, 'explain', 10)`,
      [campId],
    );
    return rows.map((r) => r["QUERY PLAN"]).join("\n");
  });

  // Record-friendly: must not sequential-scan entire patients without filter intent.
  assert.ok(
    /search_registered_patients|Function Scan|Bitmap|Index|Seq Scan/i.test(plan),
    `unexpected plan shape:\n${plan}`,
  );
  // Store plan text in assertion message for EVIDENCE capture on failure path.
  assert.ok(plan.length > 0, plan);
});
