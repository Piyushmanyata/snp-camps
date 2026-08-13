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

  // Self-contained fixtures: other suites leave no guaranteed active camp/admin.
  const campId = randomUUID();
  const adminId = randomUUID();
  const assetId = randomUUID();
  const objectKey = `lifecycle-test/${assetId}.png`;
  const publisher = new pg.Client({ connectionString: DATABASE_URL });
  const deleter = new pg.Client({ connectionString: DATABASE_URL });
  await publisher.connect();
  await deleter.connect();
  try {
    // Exclusive active camp for this case (unique active-camp invariant).
    await admin.query(`update public.camps set is_active = false where is_active = true`);
    await admin.query(
      `insert into auth.users (
         id, email, confirmation_token, recovery_token,
         email_change_token_new, email_change
       ) values ($1, $2, '', '', '', '')`,
      [adminId, `${adminId}@sponsor-lifecycle.test`],
    );
    await admin.query(
      `insert into public.profiles (id, full_name, role) values ($1, 'Sponsor Lifecycle Admin', 'admin')`,
      [adminId],
    );
    await admin.query(
      `insert into public.camps (id, name, venue, is_active)
       values ($1, $2, $3, true)`,
      [campId, `Sponsor lifecycle ${campId.slice(0, 8)}`, `Venue ${campId.slice(0, 8)}`],
    );
    await admin.query(
      `insert into public.sponsor_assets
         (id,camp_id,object_key,mime_type,byte_size,created_by,state)
       values ($1,$2,$3,'image/png',12,$4,'ready')`,
      [assetId, campId, objectKey, adminId],
    );

    await deleter.query("begin");
    await asAdmin(deleter, adminId);
    const { rows: beginRows } = await deleter.query(
      "select * from public.begin_sponsor_asset_deletion($1)",
      [assetId],
    );
    assert.equal(beginRows[0].state, "deleting");

    await publisher.query("begin");
    await asAdmin(publisher, adminId);
    // Start publish while deletion holds FOR UPDATE; it must wait, then fail.
    // Attach handlers immediately so node:test does not treat the rejection as unhandled.
    const publishOutcome = publisher
      .query(
        `select public.admin_save_prescription_template($1,$2::jsonb,true)`,
        [
          campId,
          JSON.stringify({
            sections: [{ key: "remarks", label: "Remarks", heightMm: 10 }],
            sponsorLogos: [`/api/admin/sponsor-assets/${assetId}`],
          }),
        ],
      )
      .then(
        () => ({ ok: true }),
        (err) => ({ ok: false, err }),
      );

    await new Promise((resolve) => setTimeout(resolve, 50));
    await deleter.query("commit");

    const outcome = await publishOutcome;
    assert.equal(outcome.ok, false, "publish must reject after deletion commits");
    assert.match(
      String(outcome.err?.message ?? outcome.err),
      /sponsor asset is not ready/i,
    );
    try {
      await publisher.query("rollback");
    } catch {
      // Transaction already aborted after the expected raise.
    }
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
    await admin.query("delete from public.sponsor_assets where id = $1", [assetId]).catch(() => {});
    await admin.query("delete from public.camps where id = $1", [campId]).catch(() => {});
    await admin.query("delete from public.profiles where id = $1", [adminId]).catch(() => {});
    await admin.query("delete from auth.users where id = $1", [adminId]).catch(() => {});
  }
});
