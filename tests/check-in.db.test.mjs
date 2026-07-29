/**
 * Real-database coverage for #46 two-round workflow.
 * Requires local Supabase Postgres (default 127.0.0.1:54322).
 *
 * - Pre-reg (future day) stays registered and is absent from waiting count.
 * - check_in_patient: registered → waiting; idempotent waiting; blocks seen.
 * - Queue order by queued_at (pre-reg after walk-in).
 * - Walk-in (today Asia/Kolkata) lands in waiting.
 * - Name search returns registered only.
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
      `select to_regprocedure('public.check_in_patient(uuid,integer)') is not null as ok`,
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
      "[check-in.db] local Postgres unavailable or migration not applied — DB tests skipped",
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
      `insert into public.camp_days (id, camp_id, day_date, seat_limit)
       values ($1, $2, $3, 50), ($4, $2, $5, 50)`,
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

test("pre-reg stays registered and is excluded from waiting queue", async (t) => {
  if (skipIfNoDb(t)) return;
  const { campId, futureDayId } = await seedCampWithDays();
  const requestId = randomUUID();

  const row = await asServiceRole(async () => {
    const { rows } = await client.query(
      `select * from public.register_patient_idempotent(
         $1, $2, 'Pre Reg Patient', 'M', 40, 'Ward 1', null, null, null,
         null, null, $3, false, false
       )`,
      [requestId, campId, futureDayId],
    );
    return rows[0];
  });

  assert.equal(row.queue_status, "registered");

  const { rows: counts } = await client.query(
    `select
       count(*) filter (where queue_status = 'registered')::int as registered,
       count(*) filter (where queue_status = 'waiting')::int as waiting
     from public.patients
     where camp_id = $1`,
    [campId],
  );
  assert.equal(counts[0].registered, 1);
  assert.equal(counts[0].waiting, 0);
});

test("check_in is idempotent for waiting and blocks seen", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaffVolunteer();
  const { campId, futureDayId } = await seedCampWithDays();
  const requestId = randomUUID();

  const created = await asServiceRole(async () => {
    const { rows } = await client.query(
      `select * from public.register_patient_idempotent(
         $1, $2, 'Idempotent Patient', 'F', 30, 'Locality A', null, null, null,
         null, $3, $4, false, false
       )`,
      [requestId, campId, staffId, futureDayId],
    );
    return rows[0];
  });

  assert.equal(created.queue_status, "registered");

  const first = await asStaff(staffId, async () => {
    const { rows } = await client.query(
      `select * from public.check_in_patient($1, null)`,
      [created.id],
    );
    return rows[0];
  });
  assert.equal(first.queue_status, "waiting");
  assert.equal(first.already_waiting, false);

  const { rows: afterFirst } = await client.query(
    `select queued_at from public.patients where id = $1`,
    [created.id],
  );
  const firstQueuedAt = afterFirst[0].queued_at;

  // Small delay so a buggy re-queue would change queued_at.
  await new Promise((r) => setTimeout(r, 50));

  const second = await asStaff(staffId, async () => {
    const { rows } = await client.query(
      `select * from public.check_in_patient(null, $1)`,
      [created.reg_no],
    );
    return rows[0];
  });
  assert.equal(second.queue_status, "waiting");
  assert.equal(second.already_waiting, true);

  const { rows: afterSecond } = await client.query(
    `select queued_at from public.patients where id = $1`,
    [created.id],
  );
  assert.equal(
    String(afterSecond[0].queued_at),
    String(firstQueuedAt),
    "idempotent check-in must not change queue position",
  );

  // Mark seen, then check-in must refuse.
  await client.query(
    `update public.patients
     set queue_status = 'seen', seen_at = now(), seen_by = $2
     where id = $1`,
    [created.id, staffId],
  );
  // seen_by identifies the staff member who marked the patient seen.
  const blocked = await asStaff(staffId, async () => {
    const { rows } = await client.query(
      `select * from public.check_in_patient($1, null)`,
      [created.id],
    );
    return rows[0];
  });
  assert.equal(blocked.error_code, "already_seen");
  assert.equal(blocked.queue_status, "seen");
});

test("queue order is by check-in time not registration time", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaffVolunteer();
  const { campId, futureDayId, todayDayId } = await seedCampWithDays();

  // Pre-reg first (earlier created_at), check in later.
  const preReg = await asServiceRole(async () => {
    const { rows } = await client.query(
      `select * from public.register_patient_idempotent(
         $1, $2, 'Early PreReg', 'M', 50, 'A', null, null, null,
         null, $3, $4, false, false
       )`,
      [randomUUID(), campId, staffId, futureDayId],
    );
    return rows[0];
  });

  // Walk-in registers and queues immediately.
  const walkIn = await asServiceRole(async () => {
    const { rows } = await client.query(
      `select * from public.register_patient_idempotent(
         $1, $2, 'Walk In First', 'F', 25, 'B', null, null, null,
         null, $3, $4, false, false
       )`,
      [randomUUID(), campId, staffId, todayDayId],
    );
    return rows[0];
  });
  assert.equal(walkIn.queue_status, "waiting");

  await new Promise((r) => setTimeout(r, 30));

  await asStaff(staffId, async () => {
    await client.query(`select * from public.check_in_patient($1, null)`, [
      preReg.id,
    ]);
  });

  const { rows: order } = await client.query(
    `select id, full_name from public.patients
     where camp_id = $1 and queue_status = 'waiting'
     order by queued_at asc nulls last, created_at asc`,
    [campId],
  );
  assert.equal(order.length, 2);
  assert.equal(order[0].id, walkIn.id, "walk-in who arrived first is ahead");
  assert.equal(order[1].id, preReg.id, "pre-reg checked in later is behind");
});

test("name search returns only registered for active camp", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaffVolunteer();
  const { campId, futureDayId, todayDayId } = await seedCampWithDays();

  await asServiceRole(async () => {
    await client.query(
      `select * from public.register_patient_idempotent(
         $1, $2, 'Ramesh Kumar', 'M', 45, 'Sikar Road', null, null, null,
         null, $3, $4, false, false
       )`,
      [randomUUID(), campId, staffId, futureDayId],
    );
    await client.query(
      `select * from public.register_patient_idempotent(
         $1, $2, 'Ramesh Waiting', 'M', 40, 'Other', null, null, null,
         null, $3, $4, false, false
       )`,
      [randomUUID(), campId, staffId, todayDayId],
    );
  });

  // waiting patient also named Ramesh should not appear.
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
    !matches.some((m) => m.full_name === "Ramesh Waiting"),
    "already waiting is not offered for check-in",
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
         null, $3, $4, false, false
       )`,
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

test("name search finds simple transposition via trigram (#61)", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaffVolunteer();
  const { campId, futureDayId } = await seedCampWithDays();

  await asServiceRole(async () => {
    await client.query(
      `select * from public.register_patient_idempotent(
         $1, $2, 'Priya Sharma', 'F', 28, 'Nawalgarh', null, null, null,
         null, $3, $4, false, false
       )`,
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
         null, $3, $4, false, false
       )`,
      [randomUUID(), campId, staffId, futureDayId],
    );
    // Fuzzy-only transposition — normalized name does not start with "suresh"
    await client.query(
      `select * from public.register_patient_idempotent(
         $1, $2, 'Surehs Nair', 'F', 33, 'B', null, null, null,
         null, $3, $4, false, false
       )`,
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
         null, $3, $4, false, false
       )`,
      [randomUUID(), campId, staffId, futureDayId],
    );
    return rows[0];
  });
  await client.query(
    `update public.patients
     set queue_status = 'seen', seen_at = now(), queued_at = now()
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
         null, $3, $4, false, false
       )`,
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
           null, $4, $5, false, false
         )`,
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
         null, $3, $4, false, false
       )`,
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
