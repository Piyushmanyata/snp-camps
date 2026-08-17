/**
 * Real-database coverage for ADR 0013 — no FCFS Queue.
 *
 * Presence is printed_at. Lifecycle is registered → seen. Print prescription
 * records presence once and never writes queue_status or queued_at.
 *
 * The connect guard checks reachability only. A missing RPC must fail loudly:
 * treating it as "Postgres unavailable" deletes coverage exactly when a
 * migration breaks something (AGENTS.md, Testing & Evidence Governance).
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const VENUE = "print-presence-test";

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
      "[print-presence.db] local Postgres unavailable — DB tests skipped",
    );
  }
});

test.after(async () => {
  if (!client) return;
  try {
    await client.query(
      `update public.camps set is_active = false where is_active = true`,
    );
  } catch {
    /* ignore */
  }
  await client.end();
});

function skipIfNoDb(t) {
  if (!dbAvailable) {
    t.skip("local Postgres not available");
    return true;
  }
  return false;
}

async function asServiceRole(fn) {
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

async function asStaff(userId, fn) {
  await client.query("begin");
  try {
    await client.query(
      `select set_config('request.jwt.claim.role', 'authenticated', true)`,
    );
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      userId,
    ]);
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ role: "authenticated", sub: userId }),
    ]);
    const result = await fn();
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

async function seedStaffVolunteer() {
  const userId = randomUUID();
  await client.query(
    `insert into auth.users (
       id, instance_id, aud, role, email,
       encrypted_password, email_confirmed_at,
       raw_app_meta_data, raw_user_meta_data,
       confirmation_token, recovery_token, email_change,
       email_change_token_new, email_change_token_current,
       phone_change, phone_change_token, reauthentication_token,
       created_at, updated_at
     ) values (
       $1,
       '00000000-0000-0000-0000-000000000000',
       'authenticated', 'authenticated',
       $2,
       crypt('test-password-long', gen_salt('bf')),
       now(),
       '{"provider":"email","providers":["email"]}'::jsonb,
       '{}'::jsonb,
       '', '', '', '', '', '', '', '',
       now(), now()
     )`,
    [userId, `print-${userId.slice(0, 8)}@example.test`],
  );
  await client.query(
    `insert into public.profiles (id, role, full_name, email)
     values ($1, 'volunteer', 'Print Vol', $2)
     on conflict (id) do update set role = 'volunteer', disabled_at = null`,
    [userId, `print-${userId.slice(0, 8)}@example.test`],
  );
  return userId;
}

async function seedCampWithDays({ futureDate = "2099-06-15" } = {}) {
  const campId = randomUUID();
  const futureDayId = randomUUID();
  const todayDayId = randomUUID();
  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock(918273645)");
    await client.query(
      `delete from public.patients where camp_id in (
         select id from public.camps where venue = $1)`,
      [VENUE],
    );
    await client.query(
      `delete from public.camp_days where camp_id in (
         select id from public.camps where venue = $1)`,
      [VENUE],
    );
    await client.query(`delete from public.camps where venue = $1`, [VENUE]);
    await client.query(
      `update public.camps set is_active = false where is_active = true`,
    );
    await client.query(
      `insert into public.camps (id, name, is_active, venue)
       values ($1, $2, true, $3)`,
      [campId, `Print camp ${campId.slice(0, 8)}`, VENUE],
    );
    const { rows: todayRows } = await client.query(
      `select (timezone('Asia/Kolkata', now()))::date as d`,
    );
    const today = todayRows[0].d;
    await client.query(
      `insert into public.camp_days (id, camp_id, day_date, seat_limit, printing_open)
       values ($1, $2, $3, 50, false), ($4, $2, $5, 50, true)`,
      [futureDayId, campId, futureDate, todayDayId, today],
    );
    await client.query("commit");
    return { campId, futureDayId, todayDayId, today };
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

async function register(campId, dayId, name, staffId = null) {
  return asServiceRole(async () => {
    const { rows } = await client.query(
      `select * from public.register_patient_idempotent(
         $1, $2, $3, 'M', 40, 'Ward 1', null, null, null,
         null, $4, $5, false, false, false, 'self_declared', null, null, null)`,
      [randomUUID(), campId, name, staffId, dayId],
    );
    return rows[0];
  });
}

async function readPatient(id) {
  const { rows } = await client.query(
    `select queue_status, queued_at, printed_at, seen_at, checked_in_by
       from public.patients where id = $1`,
    [id],
  );
  return rows[0];
}

test("check_in_patient and its impl are gone from the catalog", async (t) => {
  if (skipIfNoDb(t)) return;
  const { rows } = await client.query(
    `select
       to_regprocedure('public.check_in_patient(uuid,integer)') is null as gone,
       to_regprocedure(
         'public.check_in_patient_registration_impl(uuid,integer)'
       ) is null as impl_gone,
       to_regprocedure('public.mark_patient_printed(uuid)') is null as old_sig_gone,
       to_regprocedure('public.mark_patient_printed(uuid,integer)')
         is not null as new_sig_present`,
  );
  assert.equal(rows[0].gone, true, "check_in_patient must be dropped");
  assert.equal(rows[0].impl_gone, true, "the impl must be dropped too");
  assert.equal(
    rows[0].old_sig_gone,
    true,
    "the old mark_patient_printed(uuid) overload must be dropped, not forked",
  );
  assert.equal(rows[0].new_sig_present, true);
});

test("mark_patient_printed keeps its execute grants after the signature change", async (t) => {
  if (skipIfNoDb(t)) return;
  const { rows } = await client.query(
    `select
       has_function_privilege('authenticated',
         'public.mark_patient_printed(uuid,integer)', 'execute') as authenticated,
       has_function_privilege('service_role',
         'public.mark_patient_printed(uuid,integer)', 'execute') as service_role,
       has_function_privilege('anon',
         'public.mark_patient_printed(uuid,integer)', 'execute') as anon`,
  );
  assert.equal(rows[0].authenticated, true);
  assert.equal(rows[0].service_role, true);
  assert.equal(rows[0].anon, false, "the desk RPC is staff-only");
});

test("walk-in today stays registered with no presence until print", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaffVolunteer();
  const { campId, todayDayId } = await seedCampWithDays();

  const walkIn = await register(campId, todayDayId, "Walk In Today", staffId);
  assert.equal(walkIn.queue_status, "registered");

  const before = await readPatient(walkIn.id);
  assert.equal(before.queue_status, "registered");
  assert.equal(before.printed_at, null, "register-only records no presence");
  assert.equal(before.queued_at, null, "registration never writes a line time");
});

test("pre-registering a future day stays registered with no presence", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaffVolunteer();
  const { campId, futureDayId } = await seedCampWithDays();

  const preReg = await register(campId, futureDayId, "Pre Reg", staffId);
  const row = await readPatient(preReg.id);
  assert.equal(row.queue_status, "registered");
  assert.equal(row.printed_at, null);
});

test("print records presence once and never writes queue_status or queued_at", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaffVolunteer();
  const { campId, todayDayId } = await seedCampWithDays();
  const patient = await register(campId, todayDayId, "Printed Once", staffId);

  const first = await asStaff(staffId, async () => {
    const { rows } = await client.query(
      `select * from public.mark_patient_printed($1, null)`,
      [patient.id],
    );
    return rows[0];
  });
  assert.equal(first.already_printed, false);
  assert.equal(first.queue_status, "registered", "print does not change status");

  const afterFirst = await readPatient(patient.id);
  assert.notEqual(afterFirst.printed_at, null, "print records presence");
  assert.equal(afterFirst.queued_at, null, "print writes no line time");
  assert.equal(afterFirst.queue_status, "registered");
  assert.equal(
    afterFirst.checked_in_by,
    staffId,
    "the volunteer who printed is attributed",
  );

  await new Promise((r) => setTimeout(r, 50));

  const second = await asStaff(staffId, async () => {
    const { rows } = await client.query(
      `select * from public.mark_patient_printed($1, null)`,
      [patient.id],
    );
    return rows[0];
  });
  assert.equal(second.already_printed, true, "a reprint is not a new arrival");

  const afterSecond = await readPatient(patient.id);
  assert.equal(
    String(afterSecond.printed_at),
    String(afterFirst.printed_at),
    "a reprint keeps the original printed_at",
  );
  assert.equal(afterSecond.queued_at, null);
});

test("scan-then-sheet writes presence once across two calls", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaffVolunteer();
  const { campId, todayDayId } = await seedCampWithDays();
  const patient = await register(campId, todayDayId, "Scan Then Sheet", staffId);

  // Scan path resolves by reg_no before navigating to the sheet.
  await asStaff(staffId, async () => {
    await client.query(`select * from public.mark_patient_printed(null, $1)`, [
      patient.reg_no,
    ]);
  });
  const afterScan = await readPatient(patient.id);
  assert.notEqual(afterScan.printed_at, null);

  await new Promise((r) => setTimeout(r, 50));

  // The sheet's POST is the idempotent safety net for a direct /print visit.
  const sheet = await asStaff(staffId, async () => {
    const { rows } = await client.query(
      `select * from public.mark_patient_printed($1, null)`,
      [patient.id],
    );
    return rows[0];
  });
  assert.equal(sheet.already_printed, true);

  const afterSheet = await readPatient(patient.id);
  assert.equal(
    String(afterSheet.printed_at),
    String(afterScan.printed_at),
    "two calls, one presence",
  );
});

test("mark seen refuses a never-printed registration and names the reason", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaffVolunteer();
  const { campId, todayDayId } = await seedCampWithDays();
  const patient = await register(campId, todayDayId, "Never Printed", staffId);

  const refused = await asStaff(staffId, async () => {
    const { rows } = await client.query(
      `select * from public.mark_seen($1, null)`,
      [patient.id],
    );
    return rows[0];
  });
  assert.equal(refused.error_code, "never_printed");
  assert.equal(refused.queue_status, "registered");
  assert.equal(refused.already_seen, false);

  const row = await readPatient(patient.id);
  assert.equal(row.seen_at, null, "a refusal marks nobody seen");
});

test("mark seen accepts a printed registration and is idempotent", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaffVolunteer();
  const { campId, todayDayId } = await seedCampWithDays();
  const patient = await register(campId, todayDayId, "Printed Then Seen", staffId);

  await asStaff(staffId, async () => {
    await client.query(`select * from public.mark_patient_printed($1, null)`, [
      patient.id,
    ]);
  });

  const first = await asStaff(staffId, async () => {
    const { rows } = await client.query(
      `select * from public.mark_seen($1, null)`,
      [patient.id],
    );
    return rows[0];
  });
  assert.equal(first.error_code, null);
  assert.equal(first.queue_status, "seen");
  assert.equal(first.already_seen, false);

  await new Promise((r) => setTimeout(r, 50));

  const second = await asStaff(staffId, async () => {
    const { rows } = await client.query(
      `select * from public.mark_seen(null, $1)`,
      [patient.reg_no],
    );
    return rows[0];
  });
  assert.equal(second.already_seen, true);
  assert.equal(
    String(second.seen_at),
    String(first.seen_at),
    "a double scan keeps the original seen_at",
  );
});

test("a seen patient may still be reprinted and stays seen", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaffVolunteer();
  const { campId, todayDayId } = await seedCampWithDays();
  const patient = await register(campId, todayDayId, "Seen Reprint", staffId);

  await asStaff(staffId, async () => {
    await client.query(`select * from public.mark_patient_printed($1, null)`, [
      patient.id,
    ]);
    await client.query(`select * from public.mark_seen($1, null)`, [patient.id]);
  });
  const afterSeen = await readPatient(patient.id);

  const reprint = await asStaff(staffId, async () => {
    const { rows } = await client.query(
      `select * from public.mark_patient_printed($1, null)`,
      [patient.id],
    );
    return rows[0];
  });
  assert.equal(reprint.already_printed, true);
  assert.equal(reprint.queue_status, "seen", "paper and status do not fight");

  const after = await readPatient(patient.id);
  assert.equal(after.queue_status, "seen");
  assert.equal(String(after.printed_at), String(afterSeen.printed_at));
  assert.equal(String(after.seen_at), String(afterSeen.seen_at));
});

test("undo mark seen restores registered and keeps printed_at", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaffVolunteer();
  const { campId, todayDayId } = await seedCampWithDays();
  const patient = await register(campId, todayDayId, "Undo Me", staffId);

  const printedAt = await asStaff(staffId, async () => {
    await client.query(`select * from public.mark_patient_printed($1, null)`, [
      patient.id,
    ]);
    await client.query(`select * from public.mark_seen($1, null)`, [patient.id]);
    return null;
  });
  void printedAt;
  const beforeUndo = await readPatient(patient.id);

  const undone = await asStaff(staffId, async () => {
    const { rows } = await client.query(
      `select * from public.undo_mark_seen($1)`,
      [patient.id],
    );
    return rows[0];
  });
  assert.equal(undone.error_code, null);
  assert.equal(
    undone.queue_status,
    "registered",
    "undo returns to registered, never to a line",
  );

  const after = await readPatient(patient.id);
  assert.equal(after.queue_status, "registered");
  assert.equal(after.seen_at, null);
  assert.equal(
    String(after.printed_at),
    String(beforeUndo.printed_at),
    "undo keeps presence so no reprint is needed to mark seen again",
  );

  // Presence survived, so mark seen works again without another print.
  const again = await asStaff(staffId, async () => {
    const { rows } = await client.query(
      `select * from public.mark_seen($1, null)`,
      [patient.id],
    );
    return rows[0];
  });
  assert.equal(again.error_code, null);
  assert.equal(again.queue_status, "seen");
});

test("no desk RPC writes waiting or queued_at", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaffVolunteer();
  const { campId, todayDayId, futureDayId } = await seedCampWithDays();

  const walkIn = await register(campId, todayDayId, "No Line Walkin", staffId);
  await register(campId, futureDayId, "No Line PreReg", staffId);

  await asStaff(staffId, async () => {
    await client.query(`select * from public.mark_patient_printed($1, null)`, [
      walkIn.id,
    ]);
    await client.query(`select * from public.mark_seen($1, null)`, [walkIn.id]);
    await client.query(`select * from public.undo_mark_seen($1)`, [walkIn.id]);
  });

  const { rows } = await client.query(
    `select
       count(*) filter (where queue_status = 'waiting')::int as waiting,
       count(*) filter (where queued_at is not null)::int as queued
     from public.patients where camp_id = $1`,
    [campId],
  );
  assert.equal(rows[0].waiting, 0, "no RPC may write the dead waiting state");
  assert.equal(rows[0].queued, 0, "no RPC may write a line time");
});

test("residual waiting rows are normalised to registered with presence", async (t) => {
  if (skipIfNoDb(t)) return;
  const { rows } = await client.query(
    `select count(*)::int as leftovers
       from public.patients
      where queue_status = 'waiting'`,
  );
  assert.equal(
    rows[0].leftovers,
    0,
    "the Phase 1 migration normalises every non-seen waiting row",
  );
});

test("a residual waiting row is still markable seen on presence alone", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaffVolunteer();
  const { campId, todayDayId } = await seedCampWithDays();
  const patient = await register(campId, todayDayId, "Residual Row", staffId);

  // Simulate a row that predates the migration: waiting, with presence.
  await client.query(
    `update public.patients
        set queue_status = 'waiting', queued_at = now(), printed_at = now()
      where id = $1`,
    [patient.id],
  );

  const seen = await asStaff(staffId, async () => {
    const { rows } = await client.query(
      `select * from public.mark_seen($1, null)`,
      [patient.id],
    );
    return rows[0];
  });
  assert.equal(
    seen.error_code,
    null,
    "presence, not queue_status, decides mark seen",
  );
  assert.equal(seen.queue_status, "seen");
});

test("printing a future camp day is refused while its window is closed", async (t) => {
  if (skipIfNoDb(t)) return;
  const staffId = await seedStaffVolunteer();
  const { campId, futureDayId } = await seedCampWithDays();
  const preReg = await register(campId, futureDayId, "Future Day", staffId);

  await assert.rejects(
    () =>
      asStaff(staffId, async () => {
        await client.query(
          `select * from public.mark_patient_printed($1, null)`,
          [preReg.id],
        );
      }),
    /PRINT_WINDOW_CLOSED/,
  );

  const { rows } = await client.query(
    `select printed_at from public.patients where id = $1`,
    [preReg.id],
  );
  assert.equal(rows[0].printed_at, null);
});

test("staff KPIs no longer return a waiting column", async (t) => {
  if (skipIfNoDb(t)) return;
  const { rows: cols } = await client.query(
    `select a.attname
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       join unnest(p.proallargtypes, p.proargmodes, p.proargnames)
         as a(atttype, attmode, attname) on true
      where n.nspname = 'public'
        and p.proname = 'staff_person_kpis'
        and a.attmode = 't'`,
  );
  const names = cols.map((c) => c.attname);
  assert.ok(names.length > 0, "expected a table-returning signature");
  assert.ok(
    !names.includes("waiting"),
    `KPIs must not invent a dead state, got ${JSON.stringify(names)}`,
  );
  assert.ok(names.includes("total"));
  assert.ok(names.includes("seen"));

  const { rows: overloads } = await client.query(
    `select count(*)::int as n
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'staff_person_kpis'`,
  );
  assert.equal(overloads[0].n, 1, "no forked overload may survive the change");
});
