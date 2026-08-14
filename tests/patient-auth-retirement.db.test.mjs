/**
 * #59 — Patient Auth capability retirement (catalog + authenticated roles).
 * Proves absence of linking RPC, ownership column, self-read, self-mutation;
 * staff provisioning still works without auto patient profiles.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
      "[patient-auth-retirement.db] local Postgres unavailable — skipped",
    );
  }
});

test.after(async () => {
  if (client) {
    try {
      await client.query(
        `delete from public.patients where camp_id in (
           select id from public.camps where venue = 'auth-retire-test'
         )`,
      );
      await client.query(
        `delete from public.camp_days where camp_id in (
           select id from public.camps where venue = 'auth-retire-test'
         )`,
      );
      await client.query(
        `delete from public.camps where venue = 'auth-retire-test'`,
      );
      await client.query(
        `delete from public.profiles where email like '%@auth-retire.test'`,
      );
      await client.query(
        `delete from auth.users where email like '%@auth-retire.test'`,
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

/**
 * @param {string} userId
 * @param {(c: pg.Client) => Promise<unknown>} fn
 */
async function asAuthenticated(userId, fn) {
  await client.query("begin");
  try {
    await client.query(
      `select set_config('request.jwt.claim.role', 'authenticated', true)`,
    );
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      userId,
    ]);
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ role: "authenticated", sub: userId }),
    ]);
    await client.query(`set local role authenticated`);
    const result = await fn(client);
    await client.query("rollback");
    return result;
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * @param {"admin"|"volunteer"|"doctor"|"patient"} role
 * @param {{ disabled?: boolean }} [opts]
 */
async function seedProfile(role, opts = {}) {
  const userId = randomUUID();
  const email = `${role}-${userId.slice(0, 8)}@auth-retire.test`;
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
    `insert into public.profiles (id, role, full_name, email, disabled_at)
     values ($1, $2, $3, $4, $5)`,
    [
      userId,
      role,
      `Auth retire ${role}`,
      email,
      opts.disabled ? new Date().toISOString() : null,
    ],
  );
  return userId;
}

async function seedCampPatient(status = "registered") {
  const campId = randomUUID();
  const dayId = randomUUID();
  const patientId = randomUUID();
  const token = (randomUUID() + randomUUID()).replace(/-/g, "").slice(0, 32);
  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock(918273659)");
    await client.query(
      `update public.camps set is_active = false where is_active = true`,
    );
    await client.query(
      `insert into public.camps (id, name, is_active, venue)
       values ($1, $2, true, 'auth-retire-test')`,
      [campId, `Auth retire ${campId.slice(0, 8)}`],
    );
    await client.query(
      `insert into public.camp_days (id, camp_id, day_date, seat_limit)
       values ($1, $2, '2099-11-01', 50)`,
      [dayId, campId],
    );
    const regNo = 700000 + Math.floor(Math.random() * 99999);
    await client.query(
      `insert into public.patients (
         id, camp_id, camp_day_id, reg_no, full_name, gender, age,
         phone, queue_status, status_token
       ) values (
         $1, $2, $3, $5, 'Auth Retire Patient', 'M', 40,
         '9999000111', $6, $4
       )`,
      [patientId, campId, dayId, token, regNo, status],
    );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
  return { campId, dayId, patientId };
}

test("catalog: link_patient_phone absent; patients.user_id absent; no role default", async (t) => {
  if (skipIfNoDb(t)) return;

  const { rows: linkFns } = await client.query(
    `select p.proname
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'link_patient%'`,
  );
  assert.equal(linkFns.length, 0, "link_patient* must be dropped");

  const { rows: cols } = await client.query(
    `select column_name
     from information_schema.columns
     where table_schema = 'public'
       and table_name = 'patients'
       and column_name = 'user_id'`,
  );
  assert.equal(cols.length, 0, "patients.user_id must be dropped");

  const { rows: def } = await client.query(
    `select column_default
     from information_schema.columns
     where table_schema = 'public'
       and table_name = 'profiles'
       and column_name = 'role'`,
  );
  assert.equal(def[0]?.column_default, null, "profiles.role must have no DEFAULT");

  const { rows: policy } = await client.query(
    `select pg_get_expr(polqual, polrelid) as using_expr
     from pg_policy
     where polrelid = 'public.patients'::regclass
       and polname = 'authenticated read permitted patients'`,
  );
  assert.ok(policy[0]?.using_expr, "SELECT policy must exist");
  assert.doesNotMatch(
    policy[0].using_expr,
    /user_id/i,
    "SELECT policy must not reference ownership user_id",
  );
  assert.match(policy[0].using_expr, /is_admin|is_staff/i);

  const { rows: handle } = await client.query(
    `select pg_get_functiondef(p.oid) as def
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'handle_new_user'`,
  );
  assert.ok(handle[0]?.def);
  assert.doesNotMatch(
    handle[0].def,
    /insert into public\.profiles/i,
    "handle_new_user must not insert profiles",
  );
});

test("residual patient-role profile cannot read patients or change day", async (t) => {
  if (skipIfNoDb(t)) return;
  const patientUser = await seedProfile("patient");
  const { patientId, dayId } = await seedCampPatient("registered");

  const rows = await asAuthenticated(patientUser, async (c) => {
    const { rows: r } = await c.query(
      `select id, full_name from public.patients where id = $1`,
      [patientId],
    );
    return r;
  });
  assert.equal(rows.length, 0, "patient profile must not self-read patients");

  await asAuthenticated(patientUser, async (c) => {
    await assert.rejects(
      () =>
        c.query(`select * from public.change_camp_day($1, $2)`, [
          patientId,
          dayId,
        ]),
      /Not allowed|permission denied|not allowed/i,
    );
  });
});

test("staff can change camp day; disabled staff denied", async (t) => {
  if (skipIfNoDb(t)) return;
  const volunteer = await seedProfile("volunteer");
  const disabled = await seedProfile("volunteer", { disabled: true });
  const { patientId, dayId, campId } = await seedCampPatient("registered");
  const altDay = randomUUID();
  await client.query(
    `insert into public.camp_days (id, camp_id, day_date, seat_limit)
     values ($1, $2, '2099-11-02', 50)`,
    [altDay, campId],
  );

  const changed = await asAuthenticated(volunteer, async (c) => {
    const { rows } = await c.query(
      `select camp_day_id from public.change_camp_day($1, $2)`,
      [patientId, altDay],
    );
    return rows;
  });
  assert.equal(changed[0]?.camp_day_id, altDay);

  await asAuthenticated(disabled, async (c) => {
    await assert.rejects(
      () =>
        c.query(`select * from public.change_camp_day($1, $2)`, [
          patientId,
          dayId,
        ]),
      /Not allowed|not allowed/i,
    );
  });
});

test("explicit staff profile insert works without handle_new_user side effect", async (t) => {
  if (skipIfNoDb(t)) return;
  const userId = randomUUID();
  const email = `doctor-${userId.slice(0, 8)}@auth-retire.test`;

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
       '{"full_name":"New Doctor"}'::jsonb,
       now(), now()
     )`,
    [userId, email],
  );

  // Simulate post-auth: no automatic profile row.
  const { rows: before } = await client.query(
    `select id from public.profiles where id = $1`,
    [userId],
  );
  assert.equal(before.length, 0, "auth insert must not create patient profile");

  // Admin provisioning path: explicit role.
  await client.query(
    `insert into public.profiles (id, role, full_name, email)
     values ($1, 'doctor', 'New Doctor', $2)`,
    [userId, email],
  );
  const { rows: after } = await client.query(
    `select role::text as role from public.profiles where id = $1`,
    [userId],
  );
  assert.equal(after[0].role, "doctor");
});

test("local config disables public signup (repo source)", async () => {
  // Catalog/source evidence for enable_signup — Auth runtime is GoTrue config.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const toml = readFileSync(join(root, "supabase", "config.toml"), "utf8");
  assert.match(
    toml,
    /\[auth\][\s\S]*?enable_signup\s*=\s*false/,
    "auth.enable_signup must be false",
  );
  assert.match(
    toml,
    /\[auth\.email\][\s\S]*?enable_signup\s*=\s*false/,
    "auth.email.enable_signup must be false",
  );
});
