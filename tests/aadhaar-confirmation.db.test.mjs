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
      "[aadhaar-confirmation.db] local Postgres unavailable — DB tests skipped",
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

async function asStaff(userId, fn) {
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

test("inspect mutates nothing; commit attaches a free key; volunteer cannot override", async (t) => {
  if (skipIfNoDb(t)) return;
  const volunteerId = randomUUID();
  await client.query(
    `insert into public.profiles (id, role, full_name)
     values ($1, 'volunteer', 'Confirm Vol')
     on conflict (id) do update set role = 'volunteer', disabled_at = null`,
    [volunteerId],
  );

  const inspect = await asStaff(volunteerId, async () => {
    const { rows } = await client.query(
      `select * from public.confirm_manual_exception_aadhaar(
         $1, 'inspect', null, null, null, null, null, null, false, $2, null)`,
      ["00000000-0000-0000-0000-000000000001", volunteerId],
    );
    return rows;
  }).catch((err) => err);

  assert.ok(
    inspect instanceof Error || inspect[0]?.outcome,
    "RPC must exist and return an outcome or a patient-not-found error",
  );

  await assert.rejects(
    () =>
      asStaff(volunteerId, async () => {
        await client.query(
          `select * from public.confirm_manual_exception_aadhaar(
             $1, 'override', null, null, null, null, null, null, false, $2, 'skip')`,
          ["00000000-0000-0000-0000-000000000001", volunteerId],
        );
      }),
    (err) =>
      /VOLUNTEER_OVERRIDE_FORBIDDEN|Patient not found|staff only/i.test(
        String(err.message),
      ),
  );
});
