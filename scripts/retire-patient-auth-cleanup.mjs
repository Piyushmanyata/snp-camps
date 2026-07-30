/**
 * #59 Phase 4 — reviewed cleanup plan for obsolete patient Auth/profile rows.
 *
 * Default: dry-run inventory (counts only, no PII).
 * Destructive delete requires BOTH:
 *   SNP_PATIENT_AUTH_CLEANUP=1
 *   SNP_DEPLOYMENT_AUTHORITY_34=1   (#34 human authority)
 *
 * Usage:
 *   node scripts/retire-patient-auth-cleanup.mjs
 *   node scripts/retire-patient-auth-cleanup.mjs --execute   # still needs env gates
 */
import pg from "pg";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const execute = process.argv.includes("--execute");
const envOk =
  process.env.SNP_PATIENT_AUTH_CLEANUP === "1" &&
  process.env.SNP_DEPLOYMENT_AUTHORITY_34 === "1";

const c = new pg.Client({ connectionString: DATABASE_URL });
await c.connect();

const report = {
  mode: execute && envOk ? "execute" : "dry-run",
  capturedAt: new Date().toISOString(),
  counts: {},
  actions: [],
  blocked: null,
};

const { rows: patientProfiles } = await c.query(
  `select count(*)::int as n from public.profiles where role = 'patient'`,
);
report.counts.patient_role_profiles = patientProfiles[0].n;

const { rows: orphanAuth } = await c.query(
  `select count(*)::int as n
   from auth.users u
   left join public.profiles p on p.id = u.id
   where p.id is null`,
);
report.counts.auth_users_without_profile = orphanAuth[0].n;

const { rows: staff } = await c.query(
  `select count(*)::int as n
   from public.profiles
   where role in ('admin','volunteer','doctor')`,
);
report.counts.staff_profiles = staff[0].n;

const { rows: ownershipCol } = await c.query(
  `select count(*)::int as n
   from information_schema.columns
   where table_schema = 'public'
     and table_name = 'patients'
     and column_name = 'user_id'`,
);
report.counts.patients_user_id_column_present = ownershipCol[0].n > 0;

if (execute) {
  if (!envOk) {
    report.blocked =
      "Refusing destructive cleanup: set SNP_PATIENT_AUTH_CLEANUP=1 and SNP_DEPLOYMENT_AUTHORITY_34=1";
  } else {
    await c.query("begin");
    try {
      const delProfiles = await c.query(
        `delete from public.profiles where role = 'patient' returning id`,
      );
      report.actions.push({
        step: "delete_patient_profiles",
        rows: delProfiles.rowCount,
      });
      // Auth users that only existed for patient login and now have no profile.
      const delUsers = await c.query(
        `delete from auth.users u
         where not exists (select 1 from public.profiles p where p.id = u.id)
           and coalesce(u.raw_user_meta_data->>'e2e_suite', '') <> 'keep'
         returning id`,
      );
      report.actions.push({
        step: "delete_orphaned_auth_users",
        rows: delUsers.rowCount,
      });
      await c.query("commit");
    } catch (err) {
      await c.query("rollback");
      report.blocked = String(err?.message || err);
    }
  }
} else {
  report.actions.push({
    step: "dry-run",
    note: "No rows deleted. Re-run with --execute and env gates under #34.",
  });
}

await c.end();
console.log(JSON.stringify(report, null, 2));
