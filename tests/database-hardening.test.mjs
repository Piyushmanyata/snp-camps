import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260722010000_production_hardening.sql"
);
const sql = fs.readFileSync(migrationPath, "utf8");
const expandSql = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20260722000000_disabled_staff_expand.sql",
  ),
  "utf8",
);
const idempotencySql = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20260722005000_registration_idempotency_expand.sql",
  ),
  "utf8",
);
const schema = fs.readFileSync(
  path.join(process.cwd(), "supabase/schema.sql"),
  "utf8"
);

function functionBody(name) {
  const combined = sql + "\n" + expandSql + "\n" + idempotencySql;
  const match = combined.match(
    new RegExp(
      `create or replace function public\\.${name}\\b[\\s\\S]*?\\$\\$;`,
      "i"
    )
  );
  assert.ok(match, `Missing ${name} function body`);
  return match[0];
}

test("hardening migration is transactional and refuses schema drift", () => {
  assert.match(sql, /^begin;/im);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /Production hardening preflight failed/g);
  assert.match(sql, /to_regprocedure\(v_signature\)/i);
  assert.match(sql, /public\.register_patient\(\s*uuid,\s*text,\s*text,\s*integer,\s*text,\s*text,\s*text,\s*text,\s*uuid,\s*uuid,\s*uuid\s*\)/i);
  assert.match(sql, /public\.change_camp_day\(uuid,uuid\)/i);
  assert.match(sql, /public\.mark_patient_printed\(uuid\)/i);
  assert.match(sql, /notify pgrst, 'reload schema'/i);
  assert.match(sql, /commit;\s*$/i);
});

test("disabled staff are excluded from role helpers and privileged RPCs", () => {
  assert.match(expandSql, /add column if not exists disabled_at timestamptz/i);
  assert.match(
    expandSql,
    /create or replace function public\.is_staff\(\)[\s\S]*?p\.role in \('admin', 'volunteer', 'doctor'\)[\s\S]*?disabled_at is null/i,
  );
  assert.match(
    expandSql,
    /create or replace function public\.is_admin\(\)[\s\S]*?disabled_at is null/i,
  );
  assert.match(
    expandSql,
    /create or replace function public\.is_doctor\(\)[\s\S]*?disabled_at is null/i,
  );
  assert.match(
    expandSql,
    /revoke all privileges on table public\.profiles from anon, authenticated/i,
  );
  assert.match(expandSql, /notify pgrst, 'reload schema'/i);
  assert.match(
    functionBody("is_staff"),
    /p\.role in \('admin', 'volunteer'\)/i,
  );
  assert.doesNotMatch(functionBody("is_staff"), /'doctor'/i);

  for (const name of ["is_staff", "is_admin", "is_doctor"]) {
    assert.match(functionBody(name), /disabled_at is null/i);
  }

  for (const name of [
    "register_patient_idempotent",
    "assign_patient_doctor",
    "lookup_patient_scan",
    "doctor_my_counts",
    "volunteer_my_counts",
    "staff_person_kpis",
  ]) {
    assert.match(functionBody(name), /disabled_at is null/i);
  }
});

test("patient credentials cannot be selected by authenticated clients", () => {
  assert.match(
    sql,
    /revoke select on table public\.patients from authenticated/i
  );
  assert.match(
    sql,
    /alter table public\.patients\s*drop column (?:if exists )?account_claim_token,\s*drop column (?:if exists )?account_claim_expires_at/i
  );

  const safeGrant = sql.match(
    /grant select\s*\(([\s\S]*?)\)\s*on table public\.patients to authenticated/i
  );
  assert.ok(safeGrant, "Missing explicit authenticated patient column grant");
  assert.doesNotMatch(safeGrant[1], /account_claim_token/i);
  assert.doesNotMatch(safeGrant[1], /account_claim_expires_at/i);
  assert.match(safeGrant[1], /checked_in_by/i);
});

test("RLS limits directory access and scopes volunteers to active-camp patients", () => {
  const profilesPolicy =
    sql.match(
      /create policy "authenticated read permitted profiles"[\s\S]*?\n\);/i,
    )?.[0] ?? "";
  const patientsPolicy =
    sql.match(
      /create policy "authenticated read permitted patients"[\s\S]*?\n\);/i,
    )?.[0] ?? "";

  assert.match(
    profilesPolicy,
    /id = \(select auth\.uid\(\)\)[\s\S]*?or \(select public\.is_admin\(\)\)/i,
  );
  assert.match(
    patientsPolicy,
    /user_id = \(select auth\.uid\(\)\)[\s\S]*?or \(select public\.is_admin\(\)\)[\s\S]*?\(select public\.is_staff\(\)\)[\s\S]*?from public\.camps c[\s\S]*?c\.id = patients\.camp_id[\s\S]*?c\.is_active/i,
  );
  assert.doesNotMatch(profilesPolicy, /is_staff|is_doctor/i);
  assert.doesNotMatch(patientsPolicy, /seen_by|is_doctor/i);

  const doctorRecent = functionBody("doctor_recent_patients");
  assert.match(doctorRecent, /if not public\.is_doctor\(\)/i);
  assert.match(
    doctorRecent,
    /select p\.id, p\.reg_no, p\.full_name, p\.seen_at/i,
  );
  assert.doesNotMatch(doctorRecent, /p\.phone|p\.email|p\.address|aadhaar/i);
});

test("registration is limited to service role or active admins and volunteers", () => {
  const register = functionBody("register_patient_idempotent");
  assert.match(register, /auth\.role\(\)/i);
  assert.match(
    register,
    /v_request_role := coalesce/i,
  );
  assert.match(register, /v_request_role = 'service_role'/i);
  assert.match(register, /p\.role in \('admin', 'volunteer'\)/i);
  assert.match(register, /disabled_at is null/i);
  assert.match(
    register,
    /v_user_id := p_user_id/i,
  );
  assert.match(
    register,
    /v_created_by := \(select auth\.uid\(\)\)/i,
  );
  assert.match(
    sql,
    /drop function (?:if exists )?public\.register_patient\(/i
  );
  assert.match(
    sql,
    /drop function (?:if exists )?public\.register_patient_authorized_impl\(/i
  );
});

test("verified phone linking returns no match for self-registration but rejects ambiguity", () => {
  const linkPhone = functionBody("link_patient_phone");
  assert.match(linkPhone, /if v_count = 0 then return null;/i);
  assert.match(linkPhone, /if v_count > 1 then[\s\S]*raise exception/i);
  assert.match(linkPhone, /phone_confirmed_at[\s\S]*v_auth_phone is distinct from/i);
  assert.match(linkPhone, /\(array_agg\(p\.id order by p\.id\)\)\[1\]/i);
  assert.doesNotMatch(linkPhone, /min\(p\.id\)/i);
});

test("desk registration does not treat shared phone or name and age as identity", () => {
  const registerImpl = functionBody("register_patient_idempotent");
  assert.match(sql, /drop index if exists public\.patients_camp_phone_unique_idx/i);
  assert.match(sql, /drop index if exists public\.patients_camp_name_age_unique_idx/i);
  assert.doesNotMatch(registerImpl, /with this phone/i);
  assert.doesNotMatch(
    registerImpl,
    /v_phone10 is null[\s\S]*?p\.age = p_age/i,
  );
  assert.match(registerImpl, /v_user_id := null/i);
});

test("volunteer KPIs use the volunteer's actual registration or check-in time", () => {
  const ownCounts = functionBody("volunteer_my_counts");
  const staffCounts = functionBody("staff_person_kpis");

  assert.match(
    ownCounts,
    /created_by = \(select auth\.uid\(\)\)[\s\S]*?created_at >= p_since/i,
  );
  assert.match(
    ownCounts,
    /checked_in_by = \(select auth\.uid\(\)\)[\s\S]*?coalesce\(p\.queued_at, p\.seen_at, p\.created_at\) >= p_since/i,
  );
  assert.match(
    staffCounts,
    /checked_in_by = p_user_id[\s\S]*?coalesce\(p\.queued_at, p\.seen_at, p\.created_at\) >= v_since/i,
  );
  assert.match(staffCounts, /'Patients handled'::text/i);
});

test("doctor assignment is locked, active-camp-only, and does not invent queue or print timestamps", () => {
  const assign = functionBody("assign_patient_doctor");
  assert.match(
    sql,
    /drop function if exists public\.assign_patient_doctor\(uuid, uuid\)/i
  );
  assert.match(
    sql,
    /drop function if exists public\.checkin_patient_queue\(uuid, integer\)/i
  );
  assert.match(assign, /for update/i);
  assert.match(assign, /c\.is_active/i);
  assert.match(assign, /queue_status not in \('registered', 'waiting'\)/i);
  assert.match(assign, /v_caller_role = 'doctor'/i);
  assert.match(assign, /and p\.role = 'doctor'[\s\S]*?disabled_at is null/i);
  assert.match(assign, /'already_seen'::text/i);
  assert.match(assign, /checked_in_by = coalesce/i);
  assert.doesNotMatch(assign, /printed_at\s*=/i);
  assert.doesNotMatch(assign, /queued_at\s*=/i);
});

test("printing a completed patient never fabricates a queue timestamp", () => {
  const print = functionBody("mark_patient_printed");
  const seenBranch = print.match(
    /if r\.queue_status = 'seen' then[\s\S]*?return;/i,
  )?.[0];

  assert.ok(seenBranch, "Missing completed-patient print branch");
  assert.match(seenBranch, /set printed_at = now\(\)/i);
  assert.doesNotMatch(seenBranch, /queued_at|checked_in_by/i);
  assert.match(print, /if r\.queue_status = 'waiting' then/i);
  assert.match(print, /for update/i);
});

test("camp-day changes lock the patient and active camp before mutation", () => {
  const changeDay = functionBody("change_camp_day");
  const changeDayUi = fs.readFileSync(
    path.join(process.cwd(), "src/components/change-day.tsx"),
    "utf8",
  );
  const patientPage = fs.readFileSync(
    path.join(process.cwd(), "src/app/patient/page.tsx"),
    "utf8",
  );

  assert.match(changeDay, /where p\.id = p_patient_id[\s\S]*?for update/i);
  assert.match(changeDay, /where c\.id = r\.camp_id[\s\S]*?for share/i);
  assert.match(changeDay, /v_camp_active is distinct from true/i);
  assert.match(changeDay, /Camp is no longer active/i);
  assert.match(changeDayUi, /!campActive \|\| queueStatus === "waiting"/);
  assert.match(patientPage, /camps\(is_active\)/);
  assert.match(patientPage, /campActive=\{campActive\}/);
});

test("doctor scan lookup redacts phone and obsolete mutators are dropped", () => {
  assert.match(
    functionBody("lookup_patient_scan"),
    /case when v_caller_role = 'doctor' then null::text else r\.phone end/i
  );
  assert.match(
    sql,
    /drop function if exists public\.join_queue\(uuid, integer\)/i,
  );
  assert.match(
    sql,
    /drop function if exists public\.mark_patient_seen\(uuid\)/i,
  );
  assert.doesNotMatch(schema, /CREATE FUNCTION public\.(?:join_queue|mark_patient_seen)\b/i);
});

test("fresh-project schema resets Supabase defaults before explicit ACLs", () => {
  assert.match(
    schema,
    /REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public[\s\S]*?FROM PUBLIC, anon, authenticated, service_role/i
  );
  assert.match(
    schema,
    /REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public[\s\S]*?FROM PUBLIC, anon, authenticated, service_role/i
  );
  assert.match(
    schema,
    /GRANT SELECT\(full_name\) ON TABLE public\.patients TO authenticated/i
  );
  assert.doesNotMatch(
    schema,
    /GRANT SELECT\(account_claim_(?:token|expires_at)\) ON TABLE public\.patients TO authenticated/i
  );
  assert.match(
    schema,
    /REVOKE ALL ON FUNCTION public\.register_patient[\s\S]*?FROM PUBLIC/i
  );
  assert.match(
    schema,
    /ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated/i,
  );
  assert.match(
    schema,
    /ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC/i,
  );
  assert.doesNotMatch(
    schema,
    /ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin[\s\S]*?GRANT ALL ON FUNCTIONS TO (?:anon|authenticated)/i,
  );
  for (const source of [sql, schema]) {
    assert.match(
      source,
      /exists \(select 1 from pg_roles where rolname = 'supabase_admin'\)[\s\S]*?pg_has_role\(current_user, 'supabase_admin', 'MEMBER'\)[\s\S]*?execute 'alter default privileges for role supabase_admin/i,
    );
  }
});

test("staff deactivation is idempotent and never clears a newer disabled state", () => {
  for (const route of [
    "src/app/api/admin/doctors/route.ts",
    "src/app/api/admin/volunteers/route.ts",
  ]) {
    const source = fs.readFileSync(path.join(process.cwd(), route), "utf8");
    assert.match(source, /select\("id, role, disabled_at"\)/i);
    assert.match(source, /\.is\("disabled_at", null\)/i);
    assert.match(source, /\.select\("disabled_at"\)/i);
    assert.match(source, /changedByThisRequest/i);
    assert.match(source, /\.eq\("disabled_at", disabledAt\)/i);
    assert.doesNotMatch(
      source,
      /if \(banErr\) \{\s*await [\s\S]*?update\(\{ disabled_at: null \}\)/i,
    );
  }
});

test("authenticated profiles are read-only and deactivation fields are server-managed", () => {
  assert.match(
    sql,
    /revoke all privileges on table public\.profiles from anon, authenticated/i,
  );
  assert.match(sql, /grant select on table public\.profiles to authenticated/i);
  assert.match(
    sql,
    /drop policy if exists "authenticated update permitted profiles"/i,
  );
  assert.doesNotMatch(
    schema,
    /GRANT (?:ALL|[^;]*UPDATE)[^;]*ON TABLE public\.profiles TO authenticated/i,
  );

  for (const clientPath of [
    "src/components/patient-form.tsx",
    "src/app/patient/login/page.tsx",
  ]) {
    const client = fs.readFileSync(path.join(process.cwd(), clientPath), "utf8");
    assert.doesNotMatch(
      client,
      /\.from\(["']profiles["']\)[\s\S]{0,120}?\.update\(/i,
      `${clientPath} must not depend on client-side profile updates`,
    );
  }

  assert.match(
    schema,
    /insert into public\.profiles \(id, role, full_name, phone, email\)[\s\S]*?'patient'[\s\S]*?new\.phone/i,
  );
  assert.match(
    schema,
    /CREATE FUNCTION public\.link_patient_phone[\s\S]*?from auth\.users[\s\S]*?phone_confirmed_at[\s\S]*?v_auth_phone is distinct from '\+91' \|\| v_phone10/i,
  );
});

test("sensitive Aadhaar requests reject provider redirects", () => {
  for (const route of ["src/app/api/aadhaar-lookup/route.ts"]) {
    const source = fs.readFileSync(path.join(process.cwd(), route), "utf8");
    assert.match(source, /redirect:\s*"error"/i);
  }
});
