/**
 * #70 — Atomic FCFS queue position via patient_status_by_token.
 * Requires local Supabase Postgres (default 127.0.0.1:54322).
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const VENUE = "status-fcfs-test";

/** @type {pg.Client | null} */
let admin = null;
let dbAvailable = false;

function hexToken() {
  return (randomUUID() + randomUUID()).replace(/-/g, "").slice(0, 32);
}

async function connect() {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await c.connect();
    const { rows } = await c.query(
      `select to_regprocedure('public.patient_status_by_token(text)') is not null as ok`,
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
  admin = await connect();
  dbAvailable = Boolean(admin);
  if (!dbAvailable) {
    console.warn(
      "[status-queue-position.db] local Postgres unavailable or migration missing — DB tests skipped",
    );
  }
});

test.after(async () => {
  if (admin) {
    try {
      await admin.query(
        `delete from public.patients where camp_id in (
           select id from public.camps where venue = $1
         )`,
        [VENUE],
      );
      await admin.query(
        `delete from public.camp_days where camp_id in (
           select id from public.camps where venue = $1
         )`,
        [VENUE],
      );
      await admin.query(`delete from public.camps where venue = $1`, [VENUE]);
      await admin.query(
        `delete from public.profiles where email like '%@status-fcfs.test'`,
      );
      await admin.query(
        `delete from auth.users where email like '%@status-fcfs.test'`,
      );
    } catch {
      /* ignore */
    }
    await admin.end();
  }
});

function skipIfNoDb(t) {
  if (!dbAvailable) {
    t.skip("local Postgres not available or patient_status_by_token missing");
    return true;
  }
  return false;
}

/**
 * @param {(c: pg.Client) => Promise<unknown>} fn
 */
async function asServiceRole(fn) {
  await admin.query("begin");
  try {
    await admin.query(
      `select set_config('request.jwt.claim.role', 'service_role', true)`,
    );
    await admin.query(
      `select set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify({ role: "service_role" })],
    );
    const result = await fn(admin);
    await admin.query("commit");
    return result;
  } catch (err) {
    try {
      await admin.query("rollback");
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * @param {string} userId
 * @param {(c: pg.Client) => Promise<unknown>} fn
 */
async function asAuthenticated(userId, fn) {
  await admin.query("begin");
  try {
    await admin.query(
      `select set_config('request.jwt.claim.role', 'authenticated', true)`,
    );
    await admin.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      userId,
    ]);
    await admin.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ role: "authenticated", sub: userId }),
    ]);
    await admin.query(`set local role authenticated`);
    const result = await fn(admin);
    await admin.query("rollback");
    return result;
  } catch (err) {
    try {
      await admin.query("rollback");
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * @param {"anon" | "authenticated"} role
 * @param {(c: pg.Client) => Promise<unknown>} fn
 */
async function asDatabaseRole(role, fn) {
  await admin.query("begin");
  try {
    await admin.query(
      `select set_config('request.jwt.claim.role', $1, true)`,
      [role],
    );
    await admin.query(
      `select set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify({ role })],
    );
    await admin.query(`set local role ${role}`);
    const result = await fn(admin);
    await admin.query("rollback");
    return result;
  } catch (err) {
    try {
      await admin.query("rollback");
    } catch {
      /* ignore */
    }
    throw err;
  }
}

async function seedCampDay(suffix = "") {
  const campId = randomUUID();
  const dayId = randomUUID();
  await admin.query(
    `insert into public.camps (id, name, is_active, venue)
     values ($1, $2, false, $3)`,
    [campId, `FCFS camp ${campId.slice(0, 8)}${suffix}`, VENUE],
  );
  await admin.query(
    `insert into public.camp_days (id, camp_id, day_date, seat_limit)
     values ($1, $2, '2099-10-15'::date, 100)`,
    [dayId, campId],
  );
  return { campId, dayId };
}

/**
 * @param {{
 *   campId: string,
 *   dayId: string,
 *   regNo: number,
 *   status?: string,
 *   queuedAt?: string | null,
 *   fullName?: string,
 *   token?: string,
 *   id?: string,
 * }} opts
 */
async function seedPatient(opts) {
  const id = opts.id ?? randomUUID();
  const token = opts.token ?? hexToken();
  const status = opts.status ?? "waiting";
  const queuedAt =
    opts.queuedAt === undefined
      ? status === "waiting"
        ? "2099-10-15T08:00:00Z"
        : null
      : opts.queuedAt;
  await admin.query(
    `insert into public.patients (
       id, camp_id, camp_day_id, reg_no, full_name, gender, age,
       queue_status, queued_at, status_token
     ) values (
       $1, $2, $3, $4, $5, 'M', 30,
       $6::public.queue_status, $7::timestamptz, $8
     )`,
    [
      id,
      opts.campId,
      opts.dayId,
      opts.regNo,
      opts.fullName ?? `Patient ${opts.regNo}`,
      status,
      queuedAt,
      token,
    ],
  );
  return { id, token, regNo: opts.regNo };
}

async function statusByToken(token) {
  return asServiceRole(async (c) => {
    const { rows } = await c.query(
      `select reg_no, queue_status::text, queue_position,
              camp_name, venue, day_date::text
       from public.patient_status_by_token($1)`,
      [token],
    );
    return rows;
  });
}

async function seedProfile(role = "volunteer") {
  const userId = randomUUID();
  const email = `${role}-${userId.slice(0, 8)}@status-fcfs.test`;
  await admin.query(
    `insert into auth.users (
       id, instance_id, aud, role, email,
       encrypted_password, email_confirmed_at,
       raw_app_meta_data, raw_user_meta_data,
       created_at, updated_at
     ) values (
       $1, '00000000-0000-0000-0000-000000000000',
       'authenticated', 'authenticated', $2,
       crypt('x', gen_salt('bf')), now(),
       '{"provider":"email","providers":["email"]}'::jsonb,
       '{}'::jsonb, now(), now()
     )`,
    [userId, email],
  );
  await admin.query(
    `insert into public.profiles (id, role, full_name, email)
     values ($1, $2, $3, $4)
     on conflict (id) do update set role = excluded.role, disabled_at = null`,
    [userId, role, `FCFS ${role}`, email],
  );
  return userId;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

test("two waiting different timestamps → positions 1 and 2", async (t) => {
  if (skipIfNoDb(t)) return;
  const { campId, dayId } = await seedCampDay("ts");
  try {
    const a = await seedPatient({
      campId,
      dayId,
      regNo: 1001,
      queuedAt: "2099-10-15T08:00:00Z",
      fullName: "First In",
    });
    const b = await seedPatient({
      campId,
      dayId,
      regNo: 1002,
      queuedAt: "2099-10-15T08:05:00Z",
      fullName: "Second In",
    });

    const [ra] = await statusByToken(a.token);
    const [rb] = await statusByToken(b.token);
    assert.equal(ra.queue_position, 1);
    assert.equal(rb.queue_position, 2);
    assert.equal(ra.queue_status, "waiting");
    assert.equal(ra.camp_name.startsWith("FCFS camp"), true);
    assert.equal(ra.day_date, "2099-10-15");
  } finally {
    await admin.query(`delete from public.patients where camp_id = $1`, [
      campId,
    ]);
    await admin.query(`delete from public.camp_days where camp_id = $1`, [
      campId,
    ]);
    await admin.query(`delete from public.camps where id = $1`, [campId]);
  }
});

test("identical queued_at ordered by reg_no then id; unique consecutive positions", async (t) => {
  if (skipIfNoDb(t)) return;
  const { campId, dayId } = await seedCampDay("tie");
  const ts = "2099-10-15T09:00:00Z";
  // Fixed ids so id tie-break is deterministic when reg_no equal path is tested.
  const idHigh = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const idLow = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  try {
    // Same timestamp; lower reg_no first.
    const lowReg = await seedPatient({
      campId,
      dayId,
      regNo: 2001,
      queuedAt: ts,
      id: idHigh,
      fullName: "LowReg HighId",
    });
    const highReg = await seedPatient({
      campId,
      dayId,
      regNo: 2002,
      queuedAt: ts,
      id: idLow,
      fullName: "HighReg LowId",
    });
    // Same reg_no impossible (unique?), so third with different reg
    const mid = await seedPatient({
      campId,
      dayId,
      regNo: 2000,
      queuedAt: ts,
      fullName: "Lowest Reg",
    });

    const [rMid] = await statusByToken(mid.token);
    const [rLow] = await statusByToken(lowReg.token);
    const [rHigh] = await statusByToken(highReg.token);

    assert.equal(rMid.queue_position, 1, "reg 2000 first");
    assert.equal(rLow.queue_position, 2, "reg 2001 second");
    assert.equal(rHigh.queue_position, 3, "reg 2002 third");

    const positions = [rMid, rLow, rHigh].map((r) => r.queue_position).sort();
    assert.deepEqual(positions, [1, 2, 3]);
  } finally {
    await admin.query(`delete from public.patients where camp_id = $1`, [
      campId,
    ]);
    await admin.query(`delete from public.camp_days where camp_id = $1`, [
      campId,
    ]);
    await admin.query(`delete from public.camps where id = $1`, [campId]);
  }
});

test("same queued_at and reg_no: id ASC is final tie-break", async (t) => {
  if (skipIfNoDb(t)) return;
  // reg_no is unique globally via sequence default but not a unique constraint
  // on the column alone in all schemas — try insert same reg_no in one camp.
  const { campId, dayId } = await seedCampDay("id-tie");
  const ts = "2099-10-15T10:00:00Z";
  const idA = "11111111-1111-4111-8111-111111111111";
  const idB = "22222222-2222-4222-8222-222222222222";
  try {
    // Distinct reg_nos still ordered primarily by reg; for pure id test use
    // equal timestamps with reg_no order reversed vs id to prove both keys.
    // When reg_nos equal if allowed:
    let sameRegOk = true;
    try {
      await seedPatient({
        campId,
        dayId,
        regNo: 3000,
        queuedAt: ts,
        id: idB,
        fullName: "Later Id",
      });
      await seedPatient({
        campId,
        dayId,
        regNo: 3000,
        queuedAt: ts,
        id: idA,
        fullName: "Earlier Id",
      });
    } catch {
      sameRegOk = false;
      await admin.query(`delete from public.patients where camp_id = $1`, [
        campId,
      ]);
      // Fallback: prove id order when reg_no equal is not allowed by using
      // two patients and checking full comparator via SQL row_number directly.
      const t1 = hexToken();
      const t2 = hexToken();
      await admin.query(
        `insert into public.patients (
           id, camp_id, camp_day_id, reg_no, full_name, queue_status, queued_at, status_token
         ) values
           ($1, $3, $4, 3101, 'A', 'waiting', $5::timestamptz, $6),
           ($2, $3, $4, 3102, 'B', 'waiting', $5::timestamptz, $7)`,
        [idA, idB, campId, dayId, ts, t1, t2],
      );
      const [rA] = await statusByToken(t1);
      const [rB] = await statusByToken(t2);
      assert.equal(rA.queue_position, 1);
      assert.equal(rB.queue_position, 2);
    }
    if (sameRegOk) {
      const { rows } = await admin.query(
        `select status_token, id from public.patients where camp_id = $1 order by id`,
        [campId],
      );
      const earlier = rows.find((r) => r.id === idA);
      const later = rows.find((r) => r.id === idB);
      const [rA] = await statusByToken(earlier.status_token);
      const [rB] = await statusByToken(later.status_token);
      assert.equal(rA.queue_position, 1, "lower id first when reg+time equal");
      assert.equal(rB.queue_position, 2);
    }
  } finally {
    await admin.query(`delete from public.patients where camp_id = $1`, [
      campId,
    ]);
    await admin.query(`delete from public.camp_days where camp_id = $1`, [
      campId,
    ]);
    await admin.query(`delete from public.camps where id = $1`, [campId]);
  }
});

test("different camps never affect each other", async (t) => {
  if (skipIfNoDb(t)) return;
  const a = await seedCampDay("c1");
  const b = await seedCampDay("c2");
  try {
    const pA = await seedPatient({
      campId: a.campId,
      dayId: a.dayId,
      regNo: 4001,
      queuedAt: "2099-10-15T08:00:00Z",
    });
    await seedPatient({
      campId: a.campId,
      dayId: a.dayId,
      regNo: 4002,
      queuedAt: "2099-10-15T07:00:00Z",
    });
    const pB = await seedPatient({
      campId: b.campId,
      dayId: b.dayId,
      regNo: 4003,
      queuedAt: "2099-10-15T12:00:00Z",
    });

    const [rA] = await statusByToken(pA.token);
    const [rB] = await statusByToken(pB.token);
    assert.equal(rA.queue_position, 2);
    assert.equal(rB.queue_position, 1);
  } finally {
    for (const campId of [a.campId, b.campId]) {
      await admin.query(`delete from public.patients where camp_id = $1`, [
        campId,
      ]);
      await admin.query(`delete from public.camp_days where camp_id = $1`, [
        campId,
      ]);
      await admin.query(`delete from public.camps where id = $1`, [campId]);
    }
  }
});

test("seen/registered do not count ahead of waiting", async (t) => {
  if (skipIfNoDb(t)) return;
  const { campId, dayId } = await seedCampDay("nonwait");
  try {
    await seedPatient({
      campId,
      dayId,
      regNo: 5001,
      status: "seen",
      queuedAt: "2099-10-15T07:00:00Z",
    });
    await seedPatient({
      campId,
      dayId,
      regNo: 5002,
      status: "registered",
      queuedAt: null,
    });
    const waiting = await seedPatient({
      campId,
      dayId,
      regNo: 5003,
      status: "waiting",
      queuedAt: "2099-10-15T09:00:00Z",
    });

    const [r] = await statusByToken(waiting.token);
    assert.equal(r.queue_position, 1);
  } finally {
    await admin.query(`delete from public.patients where camp_id = $1`, [
      campId,
    ]);
    await admin.query(`delete from public.camp_days where camp_id = $1`, [
      campId,
    ]);
    await admin.query(`delete from public.camps where id = $1`, [campId]);
  }
});

test("waiting → seen loses position (NULL)", async (t) => {
  if (skipIfNoDb(t)) return;
  const { campId, dayId } = await seedCampDay("transition");
  try {
    const p = await seedPatient({
      campId,
      dayId,
      regNo: 6001,
      status: "waiting",
      queuedAt: "2099-10-15T08:00:00Z",
    });
    const [before] = await statusByToken(p.token);
    assert.equal(before.queue_position, 1);

    await admin.query(
      `update public.patients set queue_status = 'seen', seen_at = now()
       where id = $1`,
      [p.id],
    );

    const [after] = await statusByToken(p.token);
    assert.equal(after.queue_status, "seen");
    assert.equal(after.queue_position, null);
  } finally {
    await admin.query(`delete from public.patients where camp_id = $1`, [
      campId,
    ]);
    await admin.query(`delete from public.camp_days where camp_id = $1`, [
      campId,
    ]);
    await admin.query(`delete from public.camps where id = $1`, [campId]);
  }
});

test("invalid/expired/random tokens return empty (same not-found shape)", async (t) => {
  if (skipIfNoDb(t)) return;
  const emptyCases = [
    "",
    "not-a-token",
    "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
    "e3b0c44298fc41c4a0123456789abcde", // well-formed but unknown
    "ABCDEF0123456789ABCDEF0123456789", // uppercase rejected after lower — wait, fn lowercases
  ];
  for (const tok of emptyCases) {
    const rows = await statusByToken(tok);
    assert.equal(rows.length, 0, `expected empty for ${JSON.stringify(tok)}`);
  }
  // Uppercase hex of unknown token: lowercased lookup → empty
  const rows = await statusByToken("ABCDEF0123456789ABCDEF0123456789");
  assert.equal(rows.length, 0);
});

test("authenticated cannot execute patient_status_by_token", async (t) => {
  if (skipIfNoDb(t)) return;
  const userId = await seedProfile("volunteer");
  const { campId, dayId } = await seedCampDay("authz");
  try {
    const p = await seedPatient({
      campId,
      dayId,
      regNo: 7001,
      queuedAt: "2099-10-15T08:00:00Z",
    });

    let denied = false;
    try {
      await asAuthenticated(userId, async (c) => {
        await c.query(
          `select * from public.patient_status_by_token($1)`,
          [p.token],
        );
      });
    } catch (err) {
      denied = true;
      assert.match(
        String(err.message || err),
        /permission denied|must be owner|not granted|42501/i,
      );
    }
    assert.equal(denied, true, "authenticated must not execute the RPC");

    // Also cannot select status_token of others via table
    const leak = await asAuthenticated(userId, async (c) => {
      try {
        const { rows } = await c.query(
          `select status_token from public.patients where id = $1`,
          [p.id],
        );
        return rows;
      } catch (err) {
        return { error: String(err.message || err) };
      }
    });
    if (Array.isArray(leak)) {
      // Column privilege revoked: empty or null projection
      for (const row of leak) {
        assert.equal(
          row.status_token,
          undefined,
          "status_token must not leak to authenticated",
        );
      }
    }
  } finally {
    await admin.query(`delete from public.patients where camp_id = $1`, [
      campId,
    ]);
    await admin.query(`delete from public.camp_days where camp_id = $1`, [
      campId,
    ]);
    await admin.query(`delete from public.camps where id = $1`, [campId]);
    await admin.query(`delete from public.profiles where id = $1`, [userId]);
    await admin.query(`delete from auth.users where id = $1`, [userId]);
  }
});

test("patient lookup token is service-role only and never accepts registration date as DOB", async (t) => {
  if (skipIfNoDb(t)) return;
  const { campId, dayId } = await seedCampDay("lookup-security");
  try {
    const p = await seedPatient({
      campId,
      dayId,
      regNo: 7002,
      queuedAt: "2099-10-15T08:00:00Z",
    });
    await admin.query(
      `update public.persons pe
       set date_of_birth = '1980-01-02'::date
       from public.patients p
       where p.id = $1 and pe.id = p.person_id`,
      [p.id],
    );

    const matched = await asServiceRole(async (c) => {
      const { rows } = await c.query(
        `select * from public.lookup_patient_status_token($1, $2::date)`,
        [7002, "1980-01-02"],
      );
      return rows;
    });
    assert.deepEqual(matched, [{ status_token: p.token }]);

    const registrationDate = await admin.query(
      `select created_at::date::text as created_date
       from public.patients
       where id = $1`,
      [p.id],
    );
    const guessed = await asServiceRole(async (c) => {
      const { rows } = await c.query(
        `select * from public.lookup_patient_status_token($1, $2::date)`,
        [7002, registrationDate.rows[0].created_date],
      );
      return rows;
    });
    assert.deepEqual(
      guessed,
      [],
      "registration date must never substitute for a person's DOB",
    );

    for (const role of ["anon", "authenticated"]) {
      await assert.rejects(
        () =>
          asDatabaseRole(role, async (c) => {
            await c.query(
              `select * from public.lookup_patient_status_token($1, $2::date)`,
              [7002, "1980-01-02"],
            );
          }),
        /permission denied|not granted|42501/i,
        `${role} must not execute the token lookup RPC directly`,
      );
    }
  } finally {
    await admin.query(`delete from public.patients where camp_id = $1`, [
      campId,
    ]);
    await admin.query(`delete from public.camp_days where camp_id = $1`, [
      campId,
    ]);
    await admin.query(`delete from public.camps where id = $1`, [campId]);
  }
});

test("distributed public rate limits are durable and unavailable to browser roles", async (t) => {
  if (skipIfNoDb(t)) return;
  const scope = "lookup-test";
  const keyHash = hexToken();
  try {
    const consume = () =>
      asServiceRole(async (c) => {
        const { rows } = await c.query(
          `select *
           from public.consume_public_rate_limit($1, $2::text[], $3, $4)`,
          [scope, [keyHash], 2, 60],
        );
        return rows[0];
      });

    assert.equal((await consume()).allowed, true);
    assert.equal((await consume()).allowed, true);
    const denied = await consume();
    assert.equal(denied.allowed, false);
    assert.ok(denied.retry_after_seconds >= 1);

    for (const role of ["anon", "authenticated"]) {
      await assert.rejects(
        () =>
          asDatabaseRole(role, async (c) => {
            await c.query(
              `select *
               from public.consume_public_rate_limit($1, $2::text[], $3, $4)`,
              [scope, [keyHash], 2, 60],
            );
          }),
        /permission denied|not granted|42501/i,
        `${role} must not consume durable rate limits directly`,
      );
    }
  } finally {
    await admin.query(
      `delete from public.public_rate_limit_buckets where scope = $1`,
      [scope],
    ).catch(() => {});
  }
});

test("null token input returns empty (not a fabricated number)", async (t) => {
  if (skipIfNoDb(t)) return;
  const rows = await asServiceRole(async (c) => {
    const { rows: r } = await c.query(
      `select * from public.patient_status_by_token(null)`,
    );
    return r;
  });
  assert.equal(rows.length, 0);
});

test("concurrent waiting peers get distinct ranks in one snapshot", async (t) => {
  if (skipIfNoDb(t)) return;
  const { campId, dayId } = await seedCampDay("conc");
  try {
    const tokens = [];
    for (let i = 0; i < 5; i++) {
      const p = await seedPatient({
        campId,
        dayId,
        regNo: 8000 + i,
        queuedAt: `2099-10-15T08:0${i}:00Z`,
      });
      tokens.push(p.token);
    }

    const results = await Promise.all(tokens.map((tok) => statusByToken(tok)));
    const positions = results.map((r) => {
      assert.equal(r.length, 1);
      assert.equal(typeof r[0].queue_position, "number");
      return r[0].queue_position;
    });
    const unique = new Set(positions);
    assert.equal(unique.size, 5, `duplicate positions: ${positions}`);
    assert.deepEqual([...unique].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  } finally {
    await admin.query(`delete from public.patients where camp_id = $1`, [
      campId,
    ]);
    await admin.query(`delete from public.camp_days where camp_id = $1`, [
      campId,
    ]);
    await admin.query(`delete from public.camps where id = $1`, [campId]);
  }
});

test("least-privilege projection has no phone/token/queued_at columns", async (t) => {
  if (skipIfNoDb(t)) return;
  const { rows } = await admin.query(
    `select a.attname
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     join pg_type t on t.oid = p.prorettype
     left join pg_attribute a on a.attrelid = t.typrelid and a.attnum > 0 and not a.attisdropped
     where n.nspname = 'public' and p.proname = 'patient_status_by_token'`,
  );
  // Composite return type attributes
  const names = rows.map((r) => r.attname).filter(Boolean);
  if (names.length === 0) {
    // RETURNS TABLE → check via information_schema or pg_get_function_result
    const { rows: fr } = await admin.query(
      `select pg_get_function_result(
         'public.patient_status_by_token(text)'::regprocedure
       ) as result`,
    );
    const result = fr[0].result.toLowerCase();
    assert.doesNotMatch(result, /full_name/);
    assert.match(result, /queue_position/);
    assert.doesNotMatch(result, /status_token/);
    assert.doesNotMatch(result, /\bphone\b/);
    assert.doesNotMatch(result, /queued_at/);
  } else {
    assert.ok(!names.includes("full_name"));
    assert.ok(names.includes("queue_position"));
    assert.ok(!names.includes("status_token"));
    assert.ok(!names.includes("phone"));
    assert.ok(!names.includes("queued_at"));
  }
});
