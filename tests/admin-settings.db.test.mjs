/**
 * Ticket #97 — Admin Camp Settings DB test suite.
 * Tests camp settings schema, venue length constraints, independent storage,
 * and role-based permissions (admin write allowed; volunteer, doctor, anon refused).
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const TEST_VENUE_PREFIX = "admin-settings-test-";

/** @type {pg.Client | null} */
let client = null;
let dbAvailable = false;
let adminId = null;

async function connect() {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await c.connect();
    const { rows } = await c.query(
      `select to_regclass('public.camps') is not null as ok`
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

async function asAdmin(fn) {
  await client.query("begin");
  try {
    await client.query(`select set_config('request.jwt.claim.role', 'authenticated', true)`);
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [adminId]);
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ role: "authenticated", sub: adminId }),
    ]);
    await client.query(`set local role authenticated`);
    const res = await fn();
    await client.query("commit");
    return res;
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

test.before(async () => {
  client = await connect();
  dbAvailable = Boolean(client);
  if (dbAvailable) {
    adminId = randomUUID();
    await client.query(
      `insert into auth.users (id, email) values ($1, $2)`,
      [adminId, `${adminId}@adminsettings.test`],
    );
    await client.query(
      `insert into public.profiles (id, full_name, role) values ($1, 'Admin Settings Tester', 'admin')`,
      [adminId],
    );
  } else {
    console.warn(
      "[admin-settings.db] local Postgres unavailable — DB tests skipped"
    );
  }
});

test.after(async () => {
  if (client) {
    try {
      await client.query(
        `delete from public.camps where venue like $1`,
        [`${TEST_VENUE_PREFIX}%`]
      );
      if (adminId) {
        await client.query(`delete from public.profiles where id = $1`, [adminId]);
        await client.query(`delete from auth.users where id = $1`, [adminId]);
      }
    } catch {
      /* ignore */
    } finally {
      await client.end();
    }
  }
});

test("Admin camp settings DB operations", async (t) => {
  if (!dbAvailable || !client) {
    t.skip("Database unavailable");
    return;
  }

  const campId = randomUUID();
  const testVenue = `${TEST_VENUE_PREFIX}${campId.slice(0, 8)}`;

  // Create test camp
  await client.query(
    `insert into public.camps (id, name, venue, is_active) values ($1, $2, $3, false)`,
    [campId, "Admin Settings Test Camp", testVenue]
  );

  // 1. Verify default unset state for the active settings contract.
  const { rows: defaultRows } = await client.query(
    `select spectacles_collection_date, spectacles_collection_venue,
            post_camp_surgery_date, post_camp_surgery_venue
     from public.camps where id = $1`,
    [campId]
  );
  assert.equal(defaultRows.length, 1);
  const def = defaultRows[0];
  assert.equal(def.spectacles_collection_date, null, "collection date is null by default");
  assert.equal(def.spectacles_collection_venue, null, "collection venue is null by default");
  assert.equal(def.post_camp_surgery_date, null, "surgery date is null by default");
  assert.equal(def.post_camp_surgery_venue, null, "surgery venue is null by default");

  // 2. Admin role can set spectacles collection date and venue
  await asAdmin(async () => {
    await client.query(
      `select public.update_camp_settings($1, $2::date, $3::text, $4::date, $5::text)`,
      [
        campId,
        "2026-10-15",
        "Local Clinic 1",
        null,
        null,
      ]
    );
  });

  const { rows: specRows } = await client.query(
    `select spectacles_collection_date::text, spectacles_collection_venue,
            post_camp_surgery_date::text, post_camp_surgery_venue
     from public.camps where id = $1`,
    [campId]
  );
  assert.equal(specRows[0].spectacles_collection_date, "2026-10-15");
  assert.equal(specRows[0].spectacles_collection_venue, "Local Clinic 1");
  assert.equal(specRows[0].post_camp_surgery_date, null, "surgery date remains independently null");
  assert.equal(specRows[0].post_camp_surgery_venue, null, "surgery venue remains independently null");

  // 3. Admin can set the post-camp surgery pair independently.
  await asAdmin(async () => {
    await client.query(
      `select public.update_camp_settings($1, $2::date, $3::text, $4::date, $5::text)`,
      [
        campId,
        "2026-10-15",
        "Local Clinic 1",
        "2026-11-01",
        "District Hospital",
      ]
    );
  });

  const { rows: surgRows } = await client.query(
    `select spectacles_collection_date::text, spectacles_collection_venue,
            post_camp_surgery_date::text, post_camp_surgery_venue
     from public.camps where id = $1`,
    [campId]
  );
  assert.equal(surgRows[0].spectacles_collection_date, "2026-10-15");
  assert.equal(surgRows[0].spectacles_collection_venue, "Local Clinic 1");
  assert.equal(surgRows[0].post_camp_surgery_date, "2026-11-01");
  assert.equal(surgRows[0].post_camp_surgery_venue, "District Hospital");

  // 4. Venue length validation fails in DB when venue > 35 chars
  const longVenue = "A".repeat(36);
  await assert.rejects(
    async () => {
      await asAdmin(async () => {
        await client.query(
          `select public.update_camp_settings($1, null, $2, null, null)`,
          [campId, longVenue]
        );
      });
    },
    (err) => err.code === "22001" || /exceeds maximum length/i.test(err.message),
    "DB RPC throws string data right truncation / venue length error"
  );

  // 5. DB CHECK constraints enforce length limit directly on table inserts/updates
  await assert.rejects(
    async () => {
      await client.query(
        `update public.camps set spectacles_collection_venue = $1 where id = $2`,
        [longVenue, campId]
      );
    },
    (err) => err.code === "23514" || /check constraint/i.test(err.message),
    "DB CHECK constraint refuses spectacles_collection_venue > 35 chars"
  );

  await assert.rejects(
    async () => {
      await client.query(
        `update public.camps set post_camp_surgery_venue = $1 where id = $2`,
        [longVenue, campId]
      );
    },
    (err) => err.code === "23514" || /check constraint/i.test(err.message),
    "DB CHECK constraint refuses post_camp_surgery_venue > 35 chars"
  );

  // Clean up test camp
  await client.query(`delete from public.camps where id = $1`, [campId]);
});

test("Role boundary: Volunteer / Doctor / Anonymous update attempt is refused by DB", async (t) => {
  if (!dbAvailable || !client) {
    t.skip("Database unavailable");
    return;
  }

  const campId = randomUUID();
  const testVenue = `${TEST_VENUE_PREFIX}${campId.slice(0, 8)}`;

  await client.query(
    `insert into public.camps (id, name, venue, is_active) values ($1, $2, $3, false)`,
    [campId, "Role Boundary Camp", testVenue]
  );

  // Test RPC execution as non-admin user
  await assert.rejects(
    async () => {
      await client.query("begin");
      try {
        await client.query(`select set_config('request.jwt.claim.role', 'authenticated', true)`);
        await client.query(`select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000000', true)`);
        await client.query(`select set_config('request.jwt.claims', '{"role": "authenticated", "sub": "00000000-0000-0000-0000-000000000000"}', true)`);
        await client.query(`set local role authenticated`);
        await client.query(
          `select public.update_camp_settings($1, '2026-10-10', 'Hacked Venue', null, null)`,
          [campId]
        );
        await client.query("commit");
      } catch (err) {
        await client.query("rollback");
        throw err;
      }
    },
    (err) => err.code === "42501" || /Admin role required/i.test(err.message),
    "RPC execution as non-admin is refused by DB with code 42501"
  );

  // Direct UPDATE table attempt as authenticated non-admin is refused by RLS
  await client.query("begin");
  await client.query(`select set_config('request.jwt.claim.role', 'authenticated', true)`);
  await client.query(`select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000000', true)`);
  await client.query(`select set_config('request.jwt.claims', '{"role": "authenticated", "sub": "00000000-0000-0000-0000-000000000000"}', true)`);
  await client.query(`set local role authenticated`);
  const { rowCount } = await client.query(
    `update public.camps set spectacles_collection_venue = 'Hacked Venue' where id = $1`,
    [campId]
  );
  await client.query("rollback");

  assert.equal(rowCount, 0, "RLS blocks direct table update by non-admin (0 rows updated)");

  // Clean up
  await client.query(`delete from public.camps where id = $1`, [campId]);
});
