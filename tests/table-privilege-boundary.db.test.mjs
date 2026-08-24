/**
 * Residual baseline table privileges (20260824090000).
 *
 * RLS never filters TRUNCATE, so a TRUNCATE grant sits outside every policy on
 * the table. The four baseline tables carried TRUNCATE/TRIGGER/REFERENCES from
 * Supabase's default privileges. These assertions run as the real anon and
 * authenticated roles rather than reading the catalog alone.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const BASELINE_TABLES = ["camps", "camp_days", "patients", "profiles"];

/** @type {pg.Client | null} */
let client = null;
let dbAvailable = false;

test.before(async () => {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await c.connect();
    client = c;
    dbAvailable = true;
  } catch {
    try {
      await c.end();
    } catch {
      /* ignore */
    }
    console.warn(
      "[table-privilege-boundary.db] local Postgres unavailable — DB tests skipped",
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

/** @param {"anon" | "authenticated"} role @param {string} sql */
async function asRole(role, sql) {
  await client.query("begin");
  try {
    await client.query(`set local role ${role}`);
    await client.query(sql);
    return null;
  } catch (err) {
    return err;
  } finally {
    await client.query("rollback");
  }
}

test("no public table grants TRUNCATE, TRIGGER or REFERENCES to anon or authenticated", async (t) => {
  if (skipIfNoDb(t)) return;
  const { rows } = await client.query(
    `select table_name, grantee, privilege_type
       from information_schema.role_table_grants
      where table_schema = 'public'
        and grantee in ('anon', 'authenticated')
        and privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES')
      order by 1, 2, 3`,
  );
  assert.deepEqual(
    rows,
    [],
    `residual grants: ${rows.map((r) => `${r.table_name}:${r.grantee}:${r.privilege_type}`).join(", ")}`,
  );
});

test("authenticated and anon are refused TRUNCATE on every baseline table", async (t) => {
  if (skipIfNoDb(t)) return;
  for (const table of BASELINE_TABLES) {
    for (const role of ["anon", "authenticated"]) {
      const err = await asRole(role, `truncate table public.${table}`);
      assert.ok(err, `${role} was allowed to truncate ${table}`);
      assert.equal(
        err.code,
        "42501",
        `${role} truncate ${table} failed with ${err.code}, expected permission denied`,
      );
    }
  }
});

test("the reads the app depends on survive the revoke", async (t) => {
  if (skipIfNoDb(t)) return;
  assert.equal(await asRole("anon", "select 1 from public.camps limit 1"), null);
  assert.equal(
    await asRole("authenticated", "select 1 from public.camp_days limit 1"),
    null,
  );
  assert.equal(
    await asRole("authenticated", "select 1 from public.profiles limit 1"),
    null,
  );
});
