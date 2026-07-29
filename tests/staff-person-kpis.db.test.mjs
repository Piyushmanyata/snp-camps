/**
 * Real-Postgres contract coverage for the single active-Camp KPI RPC
 * (#119/#120).
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const KPI_SIGNATURE =
  "public.staff_person_kpis(uuid,text,uuid,timestamp with time zone,text)";

/** @type {pg.Client | null} */
let client = null;
let dbAvailable = false;

test.before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await client.connect();
    const { rows } = await client.query(
      `select to_regprocedure($1) is not null as ok`,
      [KPI_SIGNATURE],
    );
    dbAvailable = rows[0]?.ok === true;
  } catch {
    dbAvailable = false;
  }
});

test.after(async () => {
  if (client) await client.end().catch(() => {});
});

function skipIfNoDb(t) {
  if (!dbAvailable) {
    t.skip("local Postgres or final KPI migration unavailable");
    return true;
  }
  return false;
}

async function profile(role, { leadId = null, name = null } = {}) {
  const id = randomUUID();
  const email = `kpi-${role}-${id.slice(0, 8)}@test.local`;
  await client.query(
    `insert into auth.users (
       id, instance_id, aud, role, email, encrypted_password,
       email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
       created_at, updated_at
     ) values (
       $1, '00000000-0000-0000-0000-000000000000',
       'authenticated', 'authenticated', $2,
       crypt('test-password-long', gen_salt('bf')), now(),
       '{"provider":"email","providers":["email"]}'::jsonb,
       '{}'::jsonb, now(), now()
     )`,
    [id, email],
  );
  await client.query(
    `insert into public.profiles (
       id, role, full_name, email, team_lead_id
     ) values ($1, $2::public.user_role, $3, $4, $5)`,
    [id, role, name ?? `KPI ${role} ${id.slice(0, 4)}`, email, leadId],
  );
  return id;
}

async function camp({ active = true, name = "KPI Camp" } = {}) {
  const campId = randomUUID();
  const dayId = randomUUID();
  if (active) {
    await client.query(
      `update public.camps set is_active = false where is_active`,
    );
  }
  await client.query(
    `insert into public.camps (id, name, venue, is_active)
     values ($1, $2, 'KPI venue', $3)`,
    [campId, `${name} ${campId.slice(0, 5)}`, active],
  );
  await client.query(
    `insert into public.camp_days (id, camp_id, day_date, seat_limit)
     values ($1, $2, '2099-08-01', 100)`,
    [dayId, campId],
  );
  return { campId, dayId };
}

async function patient(
  campId,
  dayId,
  { createdBy = null, checkedInBy = null, seenBy = null, status = "waiting" },
) {
  const id = randomUUID();
  await client.query(
    `insert into public.patients (
       id, camp_id, camp_day_id, full_name, queue_status,
       created_by, checked_in_by, seen_by, seen_at, queued_at
     ) values (
       $1, $2, $3, $4, $5::public.queue_status,
       $6, $7, $8,
       case when $5 = 'seen' then now() else null end,
       case when $5 in ('waiting', 'seen') then now() else null end
     )`,
    [
      id,
      campId,
      dayId,
      `KPI Patient ${id.slice(0, 5)}`,
      status,
      createdBy,
      checkedInBy,
      seenBy,
    ],
  );
  return id;
}

async function asUser(userId, sql, params = []) {
  await client.query("set local role authenticated");
  await client.query(
    `select set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify({ sub: userId, role: "authenticated" })],
  );
  try {
    const result = await client.query(sql, params);
    await client.query("reset role");
    return result;
  } catch (error) {
    // The caller owns the surrounding transaction/savepoint. Do not mask the
    // original authorization error with RESET ROLE on an aborted transaction.
    throw error;
  }
}

async function personKpis(callerId, targetId, role, campId) {
  return asUser(
    callerId,
    `select * from public.staff_person_kpis(
       $1::uuid, $2::text, $3::uuid, now() - interval '1 hour', 'person'
     )`,
    [targetId, role, campId],
  );
}

async function leaderboard(callerId, campId) {
  return asUser(
    callerId,
    `select staff_id, full_name, staff_role::text, distinct_patients,
            team_lead_id, team_headcount
     from public.staff_person_kpis(
       null, null, $1::uuid, null, 'leaderboard'
     )`,
    [campId],
  );
}

test("catalog exposes one five-argument KPI contract and no leaderboard RPC", async (t) => {
  if (skipIfNoDb(t)) return;
  const { rows } = await client.query(
    `select
       count(*) filter (
         where p.pronamespace = 'public'::regnamespace
           and p.proname = 'staff_person_kpis'
       )::integer as overloads,
       to_regprocedure($1) is not null as final_signature,
       to_regprocedure(
         'public.staff_person_kpis(uuid,text,uuid,timestamptz)'
       ) is null as old_signature_absent,
       to_regprocedure(
         'public.staff_leaderboard(uuid,uuid)'
       ) is null as leaderboard_absent,
       has_function_privilege('authenticated', $1, 'EXECUTE') as auth_exec,
       has_function_privilege('anon', $1, 'EXECUTE') as anon_exec
     from pg_proc p`,
    [KPI_SIGNATURE],
  );
  assert.equal(rows[0].overloads, 1);
  assert.equal(rows[0].final_signature, true);
  assert.equal(rows[0].old_signature_absent, true);
  assert.equal(rows[0].leaderboard_absent, true);
  assert.equal(rows[0].auth_exec, true);
  assert.equal(rows[0].anon_exec, false);
});

test("volunteer metrics stay active-Camp bounded and residual doctor targets are rejected", async (t) => {
  if (skipIfNoDb(t)) return;
  await client.query("begin");
  try {
    const volunteer = await profile("volunteer");
    const doctor = await profile("doctor");
    const active = await camp();
    const inactive = await camp({ active: false, name: "Inactive KPI" });

    await patient(active.campId, active.dayId, {
      createdBy: volunteer,
      status: "waiting",
    });
    await patient(active.campId, active.dayId, {
      checkedInBy: volunteer,
      seenBy: doctor,
      status: "seen",
    });
    await patient(inactive.campId, inactive.dayId, {
      createdBy: volunteer,
      status: "waiting",
    });

    const volunteerRows = await personKpis(
      volunteer,
      volunteer,
      "volunteer",
      active.campId,
    );
    assert.deepEqual(
      volunteerRows.rows.map(({ total, waiting, seen, label }) => ({
        total: Number(total),
        waiting: Number(waiting),
        seen: Number(seen),
        label,
      })),
      [{ total: 2, waiting: 1, seen: 1, label: "Patients handled" }],
    );

    const staleCamp = await personKpis(
      volunteer,
      volunteer,
      "volunteer",
      inactive.campId,
    );
    assert.equal(Number(staleCamp.rows[0].total), 0);
    assert.equal(Number(staleCamp.rows[0].waiting), 0);
    // PostgreSQL aborts this local transaction after the authorization error,
    // so keep the residual-role rejection as the final assertion.
    await assert.rejects(
      () => personKpis(doctor, doctor, "doctor", active.campId),
      /active camp crew required/i,
    );
  } finally {
    await client.query("rollback");
  }
});

test("no active Camp returns zeros instead of all-time person totals", async (t) => {
  if (skipIfNoDb(t)) return;
  await client.query("begin");
  try {
    const volunteer = await profile("volunteer");
    const historical = await camp({ active: false });
    await patient(historical.campId, historical.dayId, {
      createdBy: volunteer,
      status: "waiting",
    });
    await client.query(`update public.camps set is_active = false`);

    const result = await personKpis(
      volunteer,
      volunteer,
      "volunteer",
      null,
    );
    assert.equal(Number(result.rows[0].total), 0);
    assert.equal(Number(result.rows[0].today), 0);
    assert.equal(Number(result.rows[0].waiting), 0);
    assert.equal(Number(result.rows[0].seen), 0);
  } finally {
    await client.query("rollback");
  }
});

test("Team Lead rollup is distinct, includes lead work, and follows current membership", async (t) => {
  if (skipIfNoDb(t)) return;
  await client.query("begin");
  try {
    const lead = await profile("team_lead", { name: "Lead A" });
    const otherLead = await profile("team_lead", { name: "Lead B" });
    const volunteerA = await profile("volunteer", {
      leadId: lead,
      name: "Volunteer A",
    });
    const volunteerB = await profile("volunteer", {
      leadId: lead,
      name: "Volunteer B",
    });
    const active = await camp();

    // One patient touched by two teammates counts once, plus the lead's work.
    await patient(active.campId, active.dayId, {
      createdBy: volunteerA,
      checkedInBy: volunteerB,
      status: "waiting",
    });
    await patient(active.campId, active.dayId, {
      createdBy: lead,
      status: "registered",
    });

    let rollup = await personKpis(
      lead,
      lead,
      "team_lead",
      active.campId,
    );
    assert.equal(Number(rollup.rows[0].total), 2);

    await client.query(
      `update public.profiles set team_lead_id = $1 where id = $2`,
      [otherLead, volunteerA],
    );
    rollup = await personKpis(lead, lead, "team_lead", active.campId);
    assert.equal(
      Number(rollup.rows[0].total),
      2,
      "volunteer B still attributes the shared patient to Lead A",
    );

    await client.query(
      `update public.profiles set team_lead_id = $1 where id = $2`,
      [otherLead, volunteerB],
    );
    rollup = await personKpis(lead, lead, "team_lead", active.campId);
    assert.equal(
      Number(rollup.rows[0].total),
      1,
      "moving both volunteers moves their handled history",
    );
    const other = await personKpis(
      otherLead,
      otherLead,
      "team_lead",
      active.campId,
    );
    assert.equal(Number(other.rows[0].total), 1);
  } finally {
    await client.query("rollback");
  }
});

test("Team Lead reads own-team aggregates but not another team", async (t) => {
  if (skipIfNoDb(t)) return;
  await client.query("begin");
  try {
    const lead = await profile("team_lead");
    const otherLead = await profile("team_lead");
    const mine = await profile("volunteer", { leadId: lead });
    const theirs = await profile("volunteer", { leadId: otherLead });
    const active = await camp();

    const own = await personKpis(lead, mine, "volunteer", active.campId);
    assert.equal(Number(own.rows[0].total), 0);

    await client.query("savepoint reject_other_volunteer");
    await assert.rejects(
      personKpis(lead, theirs, "volunteer", active.campId),
      /forbidden/i,
    );
    await client.query("rollback to savepoint reject_other_volunteer");

    await client.query("savepoint reject_other_lead");
    await assert.rejects(
      personKpis(lead, otherLead, "team_lead", active.campId),
      /forbidden/i,
    );
    await client.query("rollback to savepoint reject_other_lead");
  } finally {
    await client.query("rollback");
  }
});

test("all camp crew see deterministic aggregate-only boards including zero activity", async (t) => {
  if (skipIfNoDb(t)) return;
  await client.query("begin");
  try {
    const lead = await profile("team_lead", { name: "Alpha Lead" });
    const zeroLead = await profile("team_lead", { name: "Zero Lead" });
    const volunteer = await profile("volunteer", {
      leadId: lead,
      name: "Alpha Volunteer",
    });
    const unassigned = await profile("volunteer", {
      name: "Zero Volunteer",
    });
    const doctor = await profile("doctor");
    const admin = await profile("admin");
    const active = await camp();
    await patient(active.campId, active.dayId, {
      createdBy: volunteer,
      status: "waiting",
    });

    for (const caller of [admin, lead, volunteer]) {
      const { rows, fields } = await leaderboard(caller, active.campId);
      assert.deepEqual(
        fields.map((field) => field.name),
        [
          "staff_id",
          "full_name",
          "staff_role",
          "distinct_patients",
          "team_lead_id",
          "team_headcount",
        ],
        "leaderboard projection contains no patient detail",
      );
      assert.equal(rows.some((row) => row.staff_id === doctor), false);
      assert.equal(
        rows.find((row) => row.staff_id === lead).distinct_patients,
        1,
      );
      assert.equal(
        rows.find((row) => row.staff_id === lead).team_headcount,
        1,
      );
      assert.equal(
        rows.find((row) => row.staff_id === zeroLead).distinct_patients,
        0,
      );
      assert.equal(
        rows.find((row) => row.staff_id === unassigned).distinct_patients,
        0,
      );
      assert.equal(
        rows.find((row) => row.staff_id === unassigned).team_lead_id,
        null,
      );
      assert.deepEqual(
        rows.map((row) => row.distinct_patients),
        [...rows]
          .map((row) => row.distinct_patients)
          .sort((a, b) => b - a),
        "rows are ordered by distinct patients descending",
      );
    }
    await assert.rejects(
      () => leaderboard(doctor, active.campId),
      /active camp crew required/i,
    );
  } finally {
    await client.query("rollback");
  }
});

test("leaderboard with no active Camp contains profiles but only zero counts", async (t) => {
  if (skipIfNoDb(t)) return;
  await client.query("begin");
  try {
    const admin = await profile("admin");
    await profile("team_lead");
    await profile("volunteer");
    await client.query(`update public.camps set is_active = false`);
    const { rows } = await leaderboard(admin, null);
    assert.ok(rows.length >= 2);
    assert.equal(rows.every((row) => row.distinct_patients === 0), true);
  } finally {
    await client.query("rollback");
  }
});
