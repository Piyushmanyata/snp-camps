/**
 * #67 — Serialize concurrent likely-duplicate checks (two real DB connections).
 * Requires local Supabase Postgres (default 127.0.0.1:54322).
 *
 * Proof schedule (deterministic interleaving):
 *  1. Conn A: begin → register key K on day1 → hold open (uncommitted insert)
 *  2. Conn B: begin → register same key K on day2 (different day = no shared seat lock)
 *  3. Without camp-scoped soft locks, B inserts too (check-then-insert race).
 *  4. With advisory soft locks, B blocks until A commits, then LIKELY_DUPLICATE.
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
let admin = null;
let dbAvailable = false;

async function connect() {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await c.connect();
    const { rows } = await c.query(
      `select to_regprocedure(
         'public.register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean)'
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
  admin = await connect();
  dbAvailable = Boolean(admin);
  if (!dbAvailable) {
    console.warn(
      "[likely-duplicate-concurrency.db] local Postgres unavailable — DB tests skipped",
    );
  }
});

test.after(async () => {
  if (admin) await admin.end();
});

function skipIfNoDb(t) {
  if (!dbAvailable) {
    t.skip("local Postgres not available");
    return true;
  }
  return false;
}

function newClient() {
  return new pg.Client({ connectionString: DATABASE_URL });
}

/**
 * @param {pg.Client} c
 * @param {string} staffId
 */
async function setStaffAuth(c, staffId) {
  await c.query(
    `select set_config('request.jwt.claim.role', 'authenticated', true)`,
  );
  await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
    staffId,
  ]);
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ role: "authenticated", sub: staffId }),
  ]);
}

/**
 * @param {pg.Client} c
 * @param {object} args
 */
async function register(c, args) {
  const {
    requestId,
    campId,
    dayId,
    fullName,
    age = 40,
    phone = null,
    aadhaarLast4 = null,
    aadhaarOverride = false,
    likelyOverride = false,
  } = args;
  const { rows } = await c.query(
    `select id, reg_no, full_name, queue_status
     from public.register_patient_idempotent(
       $1::uuid, $2::uuid, $3::text,
       'M', $4::integer, 'Addr', $5::text, null, $6::text,
       null, null, $7::uuid, $8::boolean, $9::boolean
     )`,
    [
      requestId,
      campId,
      fullName,
      age,
      phone,
      aadhaarLast4,
      dayId,
      aadhaarOverride,
      likelyOverride,
    ],
  );
  return rows[0];
}

async function seedCampWithTwoDays() {
  const campId = randomUUID();
  const day1 = randomUUID();
  const day2 = randomUUID();
  await admin.query("begin");
  try {
    await admin.query("select pg_advisory_xact_lock(918273647)");
    await admin.query(
      `update public.camps set is_active = false where is_active = true`,
    );
    await admin.query(
      `insert into public.camps (id, name, is_active, venue)
       values ($1, $2, true, 'likely-dup-conc')`,
      [campId, `Likely-conc camp ${campId.slice(0, 8)}`],
    );
    await admin.query(
      `insert into public.camp_days (id, camp_id, day_date, seat_limit)
       values
         ($1, $3, '2099-10-01'::date, 50),
         ($2, $3, '2099-10-02'::date, 50)`,
      [day1, day2, campId],
    );
    await admin.query("commit");
  } catch (err) {
    await admin.query("rollback");
    throw err;
  }
  return { campId, day1, day2 };
}

async function cleanupCamp(campId) {
  await admin.query(`delete from public.patients where camp_id = $1`, [campId]);
  await admin.query(`delete from public.camp_days where camp_id = $1`, [campId]);
  await admin.query(`delete from public.camps where id = $1`, [campId]);
}

async function seedStaff() {
  const userId = randomUUID();
  await admin.query(
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
    [userId, `staff-conc-${userId.slice(0, 8)}@test.local`],
  );
  await admin.query(
    `insert into public.profiles (id, role, full_name, email)
     values ($1, 'volunteer', 'Likely Conc Staff', $2)
     on conflict (id) do update set role = excluded.role, disabled_at = null`,
    [userId, `staff-conc-${userId.slice(0, 8)}@test.local`],
  );
  return userId;
}

async function cleanupStaff(userId) {
  await admin.query(
    `update public.patients set created_by = null,
       aadhaar_duplicate_override_by = null,
       likely_duplicate_override_by = null
     where created_by = $1
        or aadhaar_duplicate_override_by = $1
        or likely_duplicate_override_by = $1`,
    [userId],
  );
  await admin.query(`delete from public.profiles where id = $1`, [userId]);
  await admin.query(`delete from auth.users where id = $1`, [userId]);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test("two connections same name+age: one insert, other LIKELY_DUPLICATE", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaff();
  const { campId, day1, day2 } = await seedCampWithTwoDays();
  const c1 = newClient();
  const c2 = newClient();
  await c1.connect();
  await c2.connect();
  try {
    const req1 = randomUUID();
    const req2 = randomUUID();
    const fullName = "Race Person Alpha";
    const age = 51;

    await c1.query("begin");
    await setStaffAuth(c1, staffId);
    const first = await register(c1, {
      requestId: req1,
      campId,
      dayId: day1,
      fullName,
      age,
    });
    assert.ok(first?.reg_no, "first registration must insert");

    // Second desk starts while first insert is still uncommitted.
    // Different camp_day so seat FOR UPDATE does not serialize the race.
    let secondSettled = false;
    const secondPromise = (async () => {
      await c2.query("begin");
      await setStaffAuth(c2, staffId);
      try {
        const row = await register(c2, {
          requestId: req2,
          campId,
          dayId: day2,
          fullName,
          age,
        });
        secondSettled = true;
        await c2.query("commit");
        return { ok: true, row };
      } catch (err) {
        secondSettled = true;
        await c2.query("rollback");
        return { ok: false, message: String(err.message || err) };
      }
    })();

    // Soft locks should keep B blocked until A commits.
    await sleep(150);
    assert.equal(
      secondSettled,
      false,
      "second registration must wait on soft-duplicate advisory lock while first txn is open",
    );

    await c1.query("commit");
    const second = await secondPromise;

    assert.equal(second.ok, false, JSON.stringify(second));
    assert.match(second.message, /LIKELY_DUPLICATE:reg=/);
    assert.match(second.message, new RegExp(String(first.reg_no)));

    const { rows: counts } = await admin.query(
      `select count(*)::int as n from public.patients where camp_id = $1`,
      [campId],
    );
    assert.equal(counts[0].n, 1, "exactly one patient row for the race key");
  } finally {
    try {
      await c1.query("rollback");
    } catch {
      /* ignore */
    }
    try {
      await c2.query("rollback");
    } catch {
      /* ignore */
    }
    await c1.end();
    await c2.end();
    await cleanupCamp(campId);
    await cleanupStaff(staffId);
  }
});

test("warned request can override once with attribution", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaff();
  const { campId, day1, day2 } = await seedCampWithTwoDays();
  try {
    const c = newClient();
    await c.connect();
    try {
      await c.query("begin");
      await setStaffAuth(c, staffId);
      const first = await register(c, {
        requestId: randomUUID(),
        campId,
        dayId: day1,
        fullName: "Override Path",
        age: 42,
        phone: "9123456780",
      });
      await c.query("commit");
      assert.ok(first?.reg_no);

      await c.query("begin");
      await setStaffAuth(c, staffId);
      let warned = null;
      try {
        await register(c, {
          requestId: randomUUID(),
          campId,
          dayId: day2,
          fullName: "Override Path",
          age: 42,
          phone: "9123456780",
        });
        await c.query("commit");
      } catch (err) {
        await c.query("rollback");
        warned = String(err.message || err);
      }
      assert.match(String(warned), /LIKELY_DUPLICATE:reg=/);

      await c.query("begin");
      await setStaffAuth(c, staffId);
      const overridden = await register(c, {
        requestId: randomUUID(),
        campId,
        dayId: day2,
        fullName: "Override Path",
        age: 42,
        phone: "9123456780",
        likelyOverride: true,
      });
      await c.query("commit");
      assert.ok(overridden?.id);
      assert.notEqual(overridden.id, first.id);

      const { rows } = await admin.query(
        `select likely_duplicate_override_by, likely_duplicate_override_at
         from public.patients where id = $1`,
        [overridden.id],
      );
      assert.equal(rows[0].likely_duplicate_override_by, staffId);
      assert.ok(rows[0].likely_duplicate_override_at);

      const { rows: counts } = await admin.query(
        `select count(*)::int as n from public.patients where camp_id = $1`,
        [campId],
      );
      assert.equal(counts[0].n, 2);
    } finally {
      await c.end();
    }
  } finally {
    await cleanupCamp(campId);
    await cleanupStaff(staffId);
  }
});

test("shared family phone different person remains overridable", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaff();
  const { campId, day1, day2 } = await seedCampWithTwoDays();
  try {
    const c = newClient();
    await c.connect();
    try {
      await c.query("begin");
      await setStaffAuth(c, staffId);
      const first = await register(c, {
        requestId: randomUUID(),
        campId,
        dayId: day1,
        fullName: "Parent One",
        age: 45,
        phone: "9000011122",
      });
      await c.query("commit");
      assert.ok(first?.reg_no);

      await c.query("begin");
      await setStaffAuth(c, staffId);
      let warned = null;
      try {
        await register(c, {
          requestId: randomUUID(),
          campId,
          dayId: day2,
          fullName: "Child Two",
          age: 12,
          phone: "9000011122",
        });
        await c.query("commit");
      } catch (err) {
        await c.query("rollback");
        warned = String(err.message || err);
      }
      assert.match(String(warned), /LIKELY_DUPLICATE:reg=/);

      await c.query("begin");
      await setStaffAuth(c, staffId);
      const child = await register(c, {
        requestId: randomUUID(),
        campId,
        dayId: day2,
        fullName: "Child Two",
        age: 12,
        phone: "9000011122",
        likelyOverride: true,
      });
      await c.query("commit");
      assert.ok(child?.id);
      assert.notEqual(child.id, first.id);
    } finally {
      await c.end();
    }
  } finally {
    await cleanupCamp(campId);
    await cleanupStaff(staffId);
  }
});

test("different duplicate keys proceed without soft-lock serialization", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaff();
  const { campId, day1, day2 } = await seedCampWithTwoDays();
  const c1 = newClient();
  const c2 = newClient();
  await c1.connect();
  await c2.connect();
  try {
    await c1.query("begin");
    await setStaffAuth(c1, staffId);
    const a = await register(c1, {
      requestId: randomUUID(),
      campId,
      dayId: day1,
      fullName: "Independent A",
      age: 30,
      phone: "9111100001",
    });
    assert.ok(a?.id);

    let bDone = false;
    const bPromise = (async () => {
      await c2.query("begin");
      await setStaffAuth(c2, staffId);
      try {
        const row = await register(c2, {
          requestId: randomUUID(),
          campId,
          dayId: day2,
          fullName: "Independent B",
          age: 31,
          phone: "9111100002",
        });
        bDone = true;
        await c2.query("commit");
        return { ok: true, row };
      } catch (err) {
        bDone = true;
        await c2.query("rollback");
        return { ok: false, message: String(err.message || err) };
      }
    })();

    // B must not wait on A's open transaction (different soft keys).
    await sleep(200);
    assert.equal(
      bDone,
      true,
      "unrelated keys must not share a global soft-duplicate lock",
    );
    const b = await bPromise;
    assert.equal(b.ok, true, b.message);

    await c1.query("commit");

    const { rows: counts } = await admin.query(
      `select count(*)::int as n from public.patients where camp_id = $1`,
      [campId],
    );
    assert.equal(counts[0].n, 2);
  } finally {
    try {
      await c1.query("rollback");
    } catch {
      /* ignore */
    }
    try {
      await c2.query("rollback");
    } catch {
      /* ignore */
    }
    await c1.end();
    await c2.end();
    await cleanupCamp(campId);
    await cleanupStaff(staffId);
  }
});

test("two-key inputs stress: no deadlock across concurrent desks", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaff();
  const { campId, day1, day2 } = await seedCampWithTwoDays();
  try {
    const ROUNDS = 8;
    for (let i = 0; i < ROUNDS; i++) {
      const name = `Two Key ${i}`;
      const age = 20 + (i % 5);
      const phone = `98${String(10000000 + i).slice(0, 8)}`;

      const run = async (dayId) => {
        const c = newClient();
        await c.connect();
        try {
          await c.query("begin");
          await setStaffAuth(c, staffId);
          try {
            const row = await register(c, {
              requestId: randomUUID(),
              campId,
              dayId,
              fullName: name,
              age,
              phone,
            });
            await c.query("commit");
            return { ok: true, row };
          } catch (err) {
            await c.query("rollback");
            return { ok: false, message: String(err.message || err) };
          }
        } finally {
          await c.end();
        }
      };

      // Race both keys (name-age + phone) from two days; lock order must not deadlock.
      const results = await Promise.race([
        Promise.all([run(day1), run(day2)]),
        sleep(8000).then(() => {
          throw new Error(`deadlock or hang on two-key stress round ${i}`);
        }),
      ]);

      const oks = results.filter((r) => r.ok);
      const fails = results.filter((r) => !r.ok);
      assert.equal(oks.length, 1, JSON.stringify(results));
      assert.equal(fails.length, 1);
      assert.match(fails[0].message, /LIKELY_DUPLICATE:reg=/);
    }
  } finally {
    await cleanupCamp(campId);
    await cleanupStaff(staffId);
  }
});

test("phone-only concurrent race serializes like name+age", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaff();
  const { campId, day1, day2 } = await seedCampWithTwoDays();
  const c1 = newClient();
  const c2 = newClient();
  await c1.connect();
  await c2.connect();
  try {
    const phone = "9333344444";
    await c1.query("begin");
    await setStaffAuth(c1, staffId);
    const first = await register(c1, {
      requestId: randomUUID(),
      campId,
      dayId: day1,
      fullName: "Phone Race One",
      age: 22,
      phone,
    });

    const secondPromise = (async () => {
      await c2.query("begin");
      await setStaffAuth(c2, staffId);
      try {
        const row = await register(c2, {
          requestId: randomUUID(),
          campId,
          dayId: day2,
          fullName: "Phone Race Two",
          age: 99,
          phone,
        });
        await c2.query("commit");
        return { ok: true, row };
      } catch (err) {
        await c2.query("rollback");
        return { ok: false, message: String(err.message || err) };
      }
    })();

    await sleep(100);
    await c1.query("commit");
    const second = await secondPromise;
    assert.equal(second.ok, false, JSON.stringify(second));
    assert.match(second.message, /LIKELY_DUPLICATE:reg=/);
    assert.match(second.message, new RegExp(String(first.reg_no)));
  } finally {
    try {
      await c1.query("rollback");
    } catch {
      /* ignore */
    }
    try {
      await c2.query("rollback");
    } catch {
      /* ignore */
    }
    await c1.end();
    await c2.end();
    await cleanupCamp(campId);
    await cleanupStaff(staffId);
  }
});
