/**
 * #59 Phase 1 — read-only inventory (no PII).
 * Counts only; never prints emails/phones/names/tokens.
 */
import pg from "pg";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const outDir = dirname(fileURLToPath(import.meta.url));
mkdirSync(outDir, { recursive: true });

const c = new pg.Client({ connectionString: DATABASE_URL });
await c.connect();

const inventory = {
  capturedAt: new Date().toISOString(),
  environment: "local",
  auth: {},
  profiles: {},
  patients: {},
  catalog: {},
  notes: [],
};

const { rows: authUsers } = await c.query(
  `select count(*)::int as n from auth.users`,
);
inventory.auth.users_total = authUsers[0].n;

const { rows: authByProvider } = await c.query(
  `select coalesce(raw_app_meta_data->>'provider', 'unknown') as provider,
          count(*)::int as n
   from auth.users
   group by 1
   order by 1`,
);
inventory.auth.users_by_provider = Object.fromEntries(
  authByProvider.map((r) => [r.provider, r.n]),
);

const { rows: roleCounts } = await c.query(
  `select role::text as role, count(*)::int as n
   from public.profiles
   group by 1
   order by 1`,
);
inventory.profiles.by_role = Object.fromEntries(
  roleCounts.map((r) => [r.role, r.n]),
);
inventory.profiles.patient_role =
  inventory.profiles.by_role.patient ?? 0;

const { rows: disabledStaff } = await c.query(
  `select count(*)::int as n
   from public.profiles
   where role in ('admin','volunteer','doctor')
     and disabled_at is not null`,
);
inventory.profiles.disabled_staff = disabledStaff[0].n;

const { rows: patientLinks } = await c.query(
  `select
     count(*)::int as patients_total,
     count(*) filter (where user_id is not null)::int as with_user_id,
     count(distinct user_id) filter (where user_id is not null)::int as distinct_linked_users
   from public.patients`,
);
inventory.patients = patientLinks[0];

const { rows: linkedRoles } = await c.query(
  `select coalesce(pr.role::text, 'no_profile') as role, count(*)::int as n
   from public.patients p
   left join public.profiles pr on pr.id = p.user_id
   where p.user_id is not null
   group by 1
   order by 1`,
);
inventory.patients.linked_user_profile_roles = Object.fromEntries(
  linkedRoles.map((r) => [r.role, r.n]),
);

// Misclassification: staff profile linked as patient owner
const { rows: staffLinked } = await c.query(
  `select count(*)::int as n
   from public.patients p
   join public.profiles pr on pr.id = p.user_id
   where pr.role in ('admin','volunteer','doctor')`,
);
inventory.patients.staff_profiles_as_owners = staffLinked[0].n;

const { rows: triggers } = await c.query(
  `select t.tgname,
          t.tgrelid::regclass::text as rel,
          p.proname,
          t.tgenabled
   from pg_trigger t
   join pg_proc p on t.tgfoid = p.oid
   where not t.tgisinternal
     and (p.proname = 'handle_new_user' or t.tgname ilike '%new_user%' or t.tgname ilike '%auth%user%')`,
);
inventory.catalog.handle_new_user_triggers = triggers;

const { rows: handleFn } = await c.query(
  `select pg_get_functiondef(p.oid) as def
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'handle_new_user'`,
);
inventory.catalog.handle_new_user_exists = handleFn.length > 0;
inventory.catalog.handle_new_user_creates_patient_role =
  handleFn[0]?.def?.includes("'patient'") ?? false;

const { rows: linkFns } = await c.query(
  `select n.nspname || '.' || p.proname || '(' ||
          pg_get_function_identity_arguments(p.oid) || ')' as signature
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where p.proname like 'link_patient%'`,
);
inventory.catalog.link_patient_functions = linkFns.map((r) => r.signature);

const { rows: linkGrants } = await c.query(
  `select grantee, privilege_type
   from information_schema.routine_privileges
   where specific_schema = 'public'
     and routine_name like 'link_patient%'`,
);
inventory.catalog.link_patient_grants = linkGrants;

const { rows: policies } = await c.query(
  `select polname, polcmd::text as cmd
   from pg_policy
   where polrelid = 'public.patients'::regclass
   order by 1`,
);
inventory.catalog.patient_policies = policies;

const { rows: selectPol } = await c.query(
  `select pg_get_expr(polqual, polrelid) as using_expr
   from pg_policy
   where polrelid = 'public.patients'::regclass
     and polname = 'authenticated read permitted patients'`,
);
inventory.catalog.select_policy_has_self_branch =
  /user_id\s*=\s*\(select auth\.uid\(\)\)/i.test(
    selectPol[0]?.using_expr ?? "",
  );

const { rows: defaultRole } = await c.query(
  `select column_default
   from information_schema.columns
   where table_schema = 'public'
     and table_name = 'profiles'
     and column_name = 'role'`,
);
inventory.catalog.profiles_role_default = defaultRole[0]?.column_default;

const { rows: userIdCol } = await c.query(
  `select c.column_name,
          (select count(*)::int from information_schema.table_constraints tc
            join information_schema.key_column_usage k
              on k.constraint_name = tc.constraint_name
             and k.table_schema = tc.table_schema
           where tc.table_schema = 'public'
             and tc.table_name = 'patients'
             and tc.constraint_type = 'FOREIGN KEY'
             and k.column_name = 'user_id') as fks
   from information_schema.columns c
   where c.table_schema = 'public'
     and c.table_name = 'patients'
     and c.column_name = 'user_id'`,
);
inventory.catalog.patients_user_id_column = userIdCol[0] ?? null;

const { rows: indexes } = await c.query(
  `select indexname
   from pg_indexes
   where schemaname = 'public'
     and tablename = 'patients'
     and indexdef ilike '%user_id%'`,
);
inventory.catalog.patients_user_id_indexes = indexes.map((r) => r.indexname);

// Auth config is not fully in DB; local config.toml known defaults recorded here.
inventory.auth.local_config_toml = {
  enable_signup: true,
  "auth.email.enable_signup": true,
  "auth.sms.enable_signup": false,
  source: "supabase/config.toml (repo)",
};
inventory.notes.push(
  "Production Auth signup settings must be verified in dashboard under #34; not readable from SQL alone.",
);
inventory.notes.push(
  "handle_new_user trigger attachment may be absent from migrations but function still creates patient profiles if attached externally.",
);
inventory.notes.push(
  "No PII exported. Counts only.",
);

await c.end();

const outPath = join(outDir, "INVENTORY.json");
writeFileSync(outPath, JSON.stringify(inventory, null, 2) + "\n");
console.log(JSON.stringify(inventory, null, 2));
console.log(`\nWrote ${outPath}`);
