/**
 * F13 — real Postgres lock coverage for publish/delete coordination.
 * Requires local Supabase Postgres (default 127.0.0.1:54322).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/** @type {pg.Client | null} */
let admin = null;
let dbAvailable = false;

async function connect() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await client.connect();
    const { rows } = await client.query(
      "select to_regprocedure('public.begin_sponsor_asset_deletion(uuid)') is not null as ok",
    );
    if (!rows[0]?.ok) {
      await client.end();
      return null;
    }
    return client;
  } catch {
    try {
      await client.end();
    } catch {
      // Ignore cleanup after an unavailable local database.
    }
    return null;
  }
}

function skipIfNoDb(t) {
  if (!dbAvailable) {
    t.skip("local Postgres / sponsor lifecycle functions not available");
    return true;
  }
  return false;
}

async function asAdmin(client, adminId) {
  await client.query("select set_config('request.jwt.claim.role', 'authenticated', true)");
  await client.query("select set_config('request.jwt.claim.sub', $1, true)", [adminId]);
  await client.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ role: "authenticated", sub: adminId }),
  ]);
}

test.before(async () => {
  admin = await connect();
  dbAvailable = Boolean(admin);
  if (!dbAvailable) {
    console.warn("[sponsor-lifecycle] local Postgres unavailable — DB test skipped");
  }
});

test.after(async () => {
  if (admin) await admin.end();
});

test("publish waits for deletion lock and rejects the now-deleting asset", async (t) => {
  if (skipIfNoDb(t)) return;
  const { rows: camps } = await admin.query(
    "select id from public.camps where is_active limit 1",
  );
  const { rows: profiles } = await admin.query(
    "select id from public.profiles where role = 'admin' and disabled_at is null limit 1",
  );
  if (!camps[0]?.id || !profiles[0]?.id) {
    t.skip("active camp and admin profile fixture required");
    return;
  }

  const assetId = randomUUID();
  const objectKey = `lifecycle-test/${assetId}.png`;
  const publisher = new pg.Client({ connectionString: DATABASE_URL });
  const deleter = new pg.Client({ connectionString: DATABASE_URL });
  await publisher.connect();
  await deleter.connect();
  try {
    await admin.query(
      `insert into public.sponsor_assets
         (id,camp_id,object_key,mime_type,byte_size,created_by,state)
       values ($1,$2,$3,'image/png',12,$4,'ready')`,
      [assetId, camps[0].id, objectKey, profiles[0].id],
    );

    await deleter.query("begin");
    await asAdmin(deleter, profiles[0].id);
    const { rows: beginRows } = await deleter.query(
      "select * from public.begin_sponsor_asset_deletion($1)",
      [assetId],
    );
    assert.equal(beginRows[0].state, "deleting");

    await publisher.query("begin");
    await asAdmin(publisher, profiles[0].id);
    const publishAttempt = publisher.query(
      `select public.admin_save_prescription_template($1,$2::jsonb,true)`,
      [
        camps[0].id,
        JSON.stringify({
          sections: [{ key: "remarks", label: "Remarks", heightMm: 10 }],
          sponsorLogos: [`/api/admin/sponsor-assets/${assetId}`],
        }),
      ],
    );

    // The publisher must be blocked behind the deleter's FOR UPDATE lock.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await deleter.query("commit");
    await assert.rejects(publishAttempt, /sponsor asset is not ready/i);
    await publisher.query("rollback");
  } finally {
    try {
      await publisher.query("rollback");
    } catch {
      // Ignore rollback after a completed transaction.
    }
    try {
      await deleter.query("rollback");
    } catch {
      // Ignore rollback after a completed transaction.
    }
    await publisher.end();
    await deleter.end();
    await admin.query("delete from public.sponsor_assets where id = $1", [assetId]);
  }
});
