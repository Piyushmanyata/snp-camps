/**
 * A team lead reads their own team's volunteers and nobody else's.
 *
 * 20260728090000 widened the profiles SELECT policy by one case. The failure it
 * fixes is silent: RLS filtered the lead's roster query to zero rows, with no
 * error, so the Team Lead desk showed an empty team however many volunteers the
 * lead had created. A test that used service_role would not see it — these
 * assertions run under the real `authenticated` role with JWT claims.
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
    const { rows } = await c.query(
      `select to_regclass('public.profiles') is not null
              and exists (
                select 1 from pg_proc where proname = 'is_team_lead_of'
              ) as ok`,
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
      "[team-lead-team-read.db] local Postgres unavailable — DB tests skipped",
    );
  }
});

test.after(async () => {
  if (client) await client.end();
});

/** Read `profiles` as a given authenticated user, inside a rolled-back tx. */
async function asUser(userId, sql, params = []) {
  await client.query("begin");
  try {
    await client.query("select set_config('role', 'authenticated', true)");
    await client.query(
      `select set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify({ sub: userId, role: "authenticated" })],
    );
    const { rows } = await client.query(sql, params);
    return rows;
  } finally {
    await client.query("rollback");
  }
}

/** profiles.id is FK → auth.users(id), so the auth row has to exist first. */
async function createStaff(role, teamLeadId = null) {
  const id = randomUUID();
  const email = `tlr-${id.slice(0, 8)}@test.local`;
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
    [id, email],
  );
  await client.query(
    `insert into public.profiles (id, role, full_name, email, team_lead_id)
     values ($1, $2::public.user_role, $3, $4, $5)`,
    [id, role, `TLR ${role}`, email, teamLeadId],
  );
  return id;
}

/** Seed a lead, two of their volunteers, and one volunteer on another team. */
async function seed() {
  const lead = await createStaff("team_lead");
  const otherLead = await createStaff("team_lead");
  const mine = [
    await createStaff("volunteer", lead),
    await createStaff("volunteer", lead),
  ];
  const theirs = await createStaff("volunteer", otherLead);
  return { lead, otherLead, mine, theirs };
}

async function cleanup(ids) {
  // profiles rows cascade from auth.users.
  await client.query(`delete from auth.users where id = any($1::uuid[])`, [ids]);
}

test("a team lead reads exactly their own team's volunteers", async (t) => {
  if (!dbAvailable) return t.skip("local Postgres not available");
  const { lead, otherLead, mine, theirs } = await seed();
  try {
    const rows = await asUser(
      lead,
      `select id from public.profiles where role = 'volunteer' and team_lead_id = $1`,
      [lead],
    );
    const seen = rows.map((r) => r.id).sort();
    assert.deepEqual(
      seen,
      [...mine].sort(),
      "lead must see both of their own volunteers and no others",
    );

    // The other team's volunteer must be invisible even when named directly.
    const direct = await asUser(lead, `select id from public.profiles where id = $1`, [
      theirs,
    ]);
    assert.equal(direct.length, 0, "lead must not read a volunteer on another team");
  } finally {
    await cleanup([lead, otherLead, ...mine, theirs]);
  }
});

test("a volunteer still reads only their own profile row", async (t) => {
  if (!dbAvailable) return t.skip("local Postgres not available");
  const { lead, otherLead, mine, theirs } = await seed();
  try {
    const rows = await asUser(mine[0], `select id from public.profiles`);
    assert.deepEqual(
      rows.map((r) => r.id),
      [mine[0]],
      "widening the policy for leads must not widen it for volunteers",
    );
  } finally {
    await cleanup([lead, otherLead, ...mine, theirs]);
  }
});

test("is_team_lead_of is false, never null, for absent and unauthenticated cases", async (t) => {
  if (!dbAvailable) return t.skip("local Postgres not available");
  const { rows } = await client.query(
    `select public.is_team_lead_of(null) as a,
            public.is_team_lead_of(gen_random_uuid()) as b`,
  );
  assert.equal(rows[0].a, false, "null profile id must be false, not null");
  assert.equal(rows[0].b, false, "unknown profile id must be false, not null");
});

test("a disabled team lead loses team visibility", async (t) => {
  if (!dbAvailable) return t.skip("local Postgres not available");
  const { lead, otherLead, mine, theirs } = await seed();
  try {
    await client.query(`update public.profiles set disabled_at = now() where id = $1`, [
      lead,
    ]);
    const rows = await asUser(
      lead,
      `select id from public.profiles where role = 'volunteer' and team_lead_id = $1`,
      [lead],
    );
    assert.equal(rows.length, 0, "a disabled lead must read no team rows");
  } finally {
    await cleanup([lead, otherLead, ...mine, theirs]);
  }
});
