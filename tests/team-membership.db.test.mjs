import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

let client;
let available = false;

test.before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await client.connect();
    available = true;
  } catch {
    available = false;
  }
});

test.after(async () => {
  if (client) await client.end().catch(() => {});
});

async function profile(role, disabledAt = null) {
  const id = randomUUID();
  const email = `${role}-${id.slice(0, 8)}@membership.test`;
  await client.query(
    `insert into auth.users (
       id, instance_id, aud, role, email,
       encrypted_password, email_confirmed_at,
       raw_app_meta_data, raw_user_meta_data,
       created_at, updated_at
     ) values (
       $1,
       '00000000-0000-0000-0000-000000000000',
       'authenticated', 'authenticated', $2,
       crypt('test-password-long', gen_salt('bf')), now(),
       '{"provider":"email","providers":["email"]}'::jsonb,
       '{}'::jsonb, now(), now()
     )`,
    [id, email],
  );
  await client.query(
    `insert into public.profiles (id, role, full_name, email, disabled_at)
     values ($1, $2, $3, $4, $5)`,
    [id, role, `Membership ${role}`, email, disabledAt],
  );
  return id;
}

test("team membership accepts active Team Leads and rejects every invalid shape", async (t) => {
  if (!available) return t.skip("local Postgres unavailable");
  await client.query("begin");
  try {
    const lead = await profile("team_lead");
    const disabledLead = await profile("team_lead", new Date());
    const doctor = await profile("doctor");
    const volunteer = await profile("volunteer");

    await client.query(
      `update public.profiles set team_lead_id = $1 where id = $2`,
      [lead, volunteer],
    );
    const assigned = await client.query(
      `select team_lead_id from public.profiles where id = $1`,
      [volunteer],
    );
    assert.equal(assigned.rows[0].team_lead_id, lead);

    for (const invalidLead of [disabledLead, doctor]) {
      await client.query("savepoint invalid_assignment");
      await assert.rejects(
        client.query(
          `update public.profiles set team_lead_id = $1 where id = $2`,
          [invalidLead, volunteer],
        ),
        /active Team Lead required/i,
      );
      await client.query("rollback to savepoint invalid_assignment");
    }

    await client.query("savepoint invalid_member");
    await assert.rejects(
      client.query(
        `update public.profiles set team_lead_id = $1 where id = $2`,
        [lead, doctor],
      ),
      /only volunteers/i,
    );
    await client.query("rollback to savepoint invalid_member");
  } finally {
    await client.query("rollback");
  }
});

test("disabling a Team Lead atomically unassigns their volunteers", async (t) => {
  if (!available) return t.skip("local Postgres unavailable");
  await client.query("begin");
  try {
    const lead = await profile("team_lead");
    const volunteer = await profile("volunteer");
    await client.query(
      `update public.profiles set team_lead_id = $1 where id = $2`,
      [lead, volunteer],
    );
    await client.query(
      `update public.profiles set disabled_at = now() where id = $1`,
      [lead],
    );
    const result = await client.query(
      `select team_lead_id from public.profiles where id = $1`,
      [volunteer],
    );
    assert.equal(result.rows[0].team_lead_id, null);
  } finally {
    await client.query("rollback");
  }
});

test("every active camp-crew role sees only the two distinct-patient leaderboards", async (t) => {
  if (!available) return t.skip("local Postgres unavailable");
  await client.query("begin");
  try {
    const lead = await profile("team_lead");
    const volunteer = await profile("volunteer");
    const doctor = await profile("doctor");
    const admin = await profile("admin");
    await client.query(
      `update public.profiles set team_lead_id = $1 where id = $2`,
      [lead, volunteer],
    );

    const campId = randomUUID();
    const dayId = randomUUID();
    await client.query("update public.camps set is_active = false where is_active");
    await client.query(
      `insert into public.camps (id, name, venue, is_active)
       values ($1, 'Leaderboard Camp', 'Venue', true)`,
      [campId],
    );
    await client.query(
      `insert into public.camp_days (id, camp_id, day_date, seat_limit)
       values ($1, $2, '2099-08-01', 50)`,
      [dayId, campId],
    );
    await client.query(
      `insert into public.patients (
         camp_id, camp_day_id, full_name, age, queue_status, created_by
       ) values ($1, $2, 'Handled Once', 30, 'registered', $3)`,
      [campId, dayId, volunteer],
    );

    for (const caller of [admin, lead, volunteer]) {
      await client.query("set local role authenticated");
      await client.query(
        `select set_config('request.jwt.claims', $1, true)`,
        [JSON.stringify({ sub: caller, role: "authenticated" })],
      );
      const { rows } = await client.query(
        `select staff_id, staff_role::text, distinct_patients, team_headcount
         from public.staff_person_kpis(
           null, null, $1, null, 'leaderboard'
         )`,
        [campId],
      );
      assert.ok(rows.some((row) => row.staff_id === lead));
      assert.ok(rows.some((row) => row.staff_id === volunteer));
      assert.equal(
        rows.every(
          (row) =>
            row.staff_role === "team_lead" ||
            row.staff_role === "volunteer",
        ),
        true,
      );
      assert.equal(
        rows.find((row) => row.staff_id === lead).distinct_patients,
        1,
      );
      assert.equal(
        rows.find((row) => row.staff_id === volunteer).distinct_patients,
        1,
      );
      await client.query("reset role");
    }

    await client.query("set local role authenticated");
    await client.query(
      `select set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify({ sub: doctor, role: "authenticated" })],
    );
    await assert.rejects(
      () =>
        client.query(
          `select * from public.staff_person_kpis(
             null, null, $1, null, 'leaderboard'
           )`,
          [campId],
        ),
      /active camp crew required/i,
    );
  } finally {
    await client.query("rollback");
  }
});
