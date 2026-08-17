import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

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
      "[status-retired.db] local Postgres unavailable — DB tests skipped",
    );
  }
});

test.after(async () => {
  if (!client) return;
  await client.end();
});

function skipIfNoDb(t) {
  if (!dbAvailable) {
    t.skip("local Postgres not available");
    return true;
  }
  return false;
}

test("patient_status_by_token is gone and status_token column is gone", async (t) => {
  if (skipIfNoDb(t)) return;
  const { rows: fns } = await client.query(
    `select 1 from pg_proc where proname = 'patient_status_by_token'`,
  );
  assert.equal(fns.length, 0);
  const { rows: cols } = await client.query(
    `select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'patients'
       and column_name = 'status_token'`,
  );
  assert.equal(cols.length, 0);
});
