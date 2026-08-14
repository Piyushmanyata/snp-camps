import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

let client = null;
let dbAvailable = false;
const userIds = {
  admin: randomUUID(),
  volunteer: randomUUID(),
  teamLead: randomUUID(),
  doctor: randomUUID(),
  disabled: randomUUID(),
};
const campId = randomUUID();
const dayId = randomUUID();

async function connect() {
  const candidate = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await candidate.connect();
    return candidate;
  } catch {
    try {
      await candidate.end();
    } catch {
      /* ignore */
    }
    return null;
  }
}

async function asAuthenticated(userId, fn) {
  await client.query("begin");
  try {
    await client.query(
      `select set_config('request.jwt.claim.role', 'authenticated', true)`,
    );
    await client.query(
      `select set_config('request.jwt.claim.sub', $1, true)`,
      [userId],
    );
    await client.query(
      `select set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify({ role: "authenticated", sub: userId })],
    );
    await client.query(`set local role authenticated`);
    const result = await fn();
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

test.before(async () => {
  client = await connect();
  dbAvailable = Boolean(client);
  if (!client) return;

  for (const [label, id] of Object.entries(userIds)) {
    await client.query(
      `insert into auth.users (id, email) values ($1, $2)`,
      [id, `${label}-${id.slice(0, 8)}@analytics.test`],
    );
  }
  await client.query(
    `insert into public.profiles (id, full_name, role, disabled_at)
     values
       ($1, 'Analytics Admin', 'admin', null),
       ($2, 'Analytics Volunteer', 'volunteer', null),
       ($3, 'Analytics Lead', 'team_lead', null),
       ($4, 'Residual Doctor', 'doctor', null),
       ($5, 'Disabled Volunteer', 'volunteer', now())`,
    [
      userIds.admin,
      userIds.volunteer,
      userIds.teamLead,
      userIds.doctor,
      userIds.disabled,
    ],
  );
  await client.query(
    `insert into public.camps (id, name, venue, is_active)
     values ($1, 'Analytics Test Camp', 'Test Venue', true)`,
    [campId],
  );
  await client.query(
    `insert into public.camp_days (id, camp_id, day_date, seat_limit)
     values ($1, $2, (timezone('Asia/Kolkata', now()))::date, 20)`,
    [dayId, campId],
  );

  // Two states only (ADR 0013). printedAgo stands in for arrival; it is
  // presence, not a line position, and no metric derives a wait from it.
  const rows = [
    ["registered", null, null, userIds.admin, "self_declared"],
    ["registered", null, null, null, "card_scanned"],
    ["registered", "30 minutes", null, userIds.admin, "card_scanned"],
    ["registered", "90 minutes", null, null, "self_declared"],
    ["seen", "10 minutes", "0 minutes", userIds.admin, "self_declared"],
    ["seen", "20 minutes", "0 minutes", userIds.admin, "card_scanned"],
    ["seen", "30 minutes", "0 minutes", null, "self_declared"],
    ["seen", "40 minutes", "0 minutes", null, "self_declared"],
    ["seen", "0 minutes", "5 minutes", userIds.admin, "self_declared"],
  ];

  for (const [status, printedAgo, seenBeforeNow, createdBy, provenance] of rows) {
    await client.query(
      `insert into public.patients (
         camp_id, camp_day_id, full_name, queue_status, printed_at, seen_at,
         seen_by, created_by, provenance
       )
       values (
         $1, $2, $3, $4::public.queue_status,
         case when $5::text is null then null else now() - $5::interval end,
         case
           when $4::text = 'seen' and $6::text is null
             then now()
           when $4::text = 'seen'
             then now() - $6::interval
           else null
         end,
         case when $4::text = 'seen' then $9::uuid else null end,
         $7, $8
       )`,
      [
        campId,
        dayId,
        `Analytics ${status} ${randomUUID().slice(0, 8)}`,
        status,
        printedAgo,
        seenBeforeNow,
        createdBy,
        provenance,
        userIds.admin,
      ],
    );
  }
});

test.after(async () => {
  if (!client) return;
  try {
    await client.query(`delete from public.patients where camp_id = $1`, [campId]);
    await client.query(`delete from public.camp_days where camp_id = $1`, [campId]);
    await client.query(`delete from public.camps where id = $1`, [campId]);
    await client.query(
      `delete from public.profiles where id = any($1::uuid[])`,
      [Object.values(userIds)],
    );
    await client.query(
      `delete from auth.users where id = any($1::uuid[])`,
      [Object.values(userIds)],
    );
  } finally {
    await client.end();
  }
});

test("admin analytics returns deterministic aggregate-only active-camp metrics", async (t) => {
  if (!dbAvailable || !client) {
    t.skip("Database unavailable");
    return;
  }

  const { rows } = await asAuthenticated(userIds.admin, () =>
    client.query(`select * from public.camp_queue_counts($1)`, [campId]),
  );
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(Number(row.registered_count), 4);
  assert.equal(Number(row.seen_count), 5);
  assert.equal(Number(row.total_count), 9);
  assert.equal(Number(row.completed_today_count), 5);
  assert.equal(Number(row.desk_registration_count), 5);
  assert.equal(Number(row.self_registration_count), 4);
  assert.equal(Number(row.scanned_registration_count), 3);
  assert.equal(Number(row.self_declared_count), 6);
  // No queue depth and no wait percentiles: both derived from queued_at, which
  // nothing writes once presence is printed_at (ADR 0013).
  assert.deepEqual(
    Object.keys(row).sort(),
    [
      "completed_today_count",
      "desk_registration_count",
      "registered_count",
      "scanned_registration_count",
      "seen_count",
      "self_declared_count",
      "self_registration_count",
      "total_count",
    ].sort(),
  );
});

test("inactive camps return the defined zero analytics state", async (t) => {
  if (!dbAvailable || !client) {
    t.skip("Database unavailable");
    return;
  }

  await client.query(`update public.camps set is_active = false where id = $1`, [
    campId,
  ]);
  try {
    const { rows } = await asAuthenticated(userIds.admin, () =>
      client.query(`select * from public.camp_queue_counts($1)`, [campId]),
    );
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].registered_count), 0);
    assert.equal(Number(rows[0].seen_count), 0);
    assert.equal(Number(rows[0].total_count), 0);
    assert.equal(Number(rows[0].completed_today_count), 0);
  } finally {
    await client.query(`update public.camps set is_active = true where id = $1`, [
      campId,
    ]);
  }
});

test("analytics RPC rejects non-admin and residual roles at the database boundary", async (t) => {
  if (!dbAvailable || !client) {
    t.skip("Database unavailable");
    return;
  }

  for (const userId of [
    userIds.volunteer,
    userIds.teamLead,
    userIds.doctor,
    userIds.disabled,
  ]) {
    await assert.rejects(
      () =>
        asAuthenticated(userId, () =>
          client.query(`select * from public.camp_queue_counts($1)`, [campId]),
        ),
      /admin only/i,
    );
  }
});
