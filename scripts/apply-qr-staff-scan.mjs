import "./load-env.mjs";
import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ref = "ruklmrzpyutvefancsgo";
const pwd = process.env.SUPABASE_DB_PASSWORD;
if (!pwd) {
  console.error("Missing SUPABASE_DB_PASSWORD");
  process.exit(1);
}

const configs = [
  {
    label: "direct",
    connectionString: `postgresql://postgres:${encodeURIComponent(pwd)}@db.${ref}.supabase.co:5432/postgres`,
  },
  {
    label: "pooler-session-aws0",
    connectionString: `postgresql://postgres.${ref}:${encodeURIComponent(pwd)}@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`,
  },
  {
    label: "pooler-session-aws1",
    connectionString: `postgresql://postgres.${ref}:${encodeURIComponent(pwd)}@aws-1-ap-south-1.pooler.supabase.com:5432/postgres`,
  },
];

async function connect() {
  const sslModes = [
    {
      label: "permissive",
      ssl: { rejectUnauthorized: false },
    },
    {
      label: "strict",
      ssl: {
        rejectUnauthorized: true,
        ...(process.env.SUPABASE_DB_CA ? { ca: process.env.SUPABASE_DB_CA } : {}),
      },
    },
  ];

  for (const c of configs) {
    for (const mode of sslModes) {
      const client = new Client({
        connectionString: c.connectionString,
        ssl: mode.ssl,
        connectionTimeoutMillis: 20000,
      });
      try {
        await client.connect();
        console.log("CONNECTED via", c.label, mode.label);
        return client;
      } catch (e) {
        console.log(
          "FAIL",
          c.label,
          mode.label,
          String(e.message).slice(0, 140),
        );
        try {
          await client.end();
        } catch {
          /* ignore */
        }
      }
    }
  }
  return null;
}

const sql = fs.readFileSync(
  path.join(__dirname, "..", "supabase", "fix-qr-staff-scan.sql"),
  "utf8",
);

const client = await connect();
if (!client) {
  console.error("Could not connect to Supabase Postgres");
  process.exit(1);
}

try {
  await client.query(sql);

  const { rows } = await client.query(`
    select p.proname,
           pg_get_function_identity_arguments(p.oid) as args,
           obj_description(p.oid, 'pg_proc') as comment
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('lookup_patient_scan', 'assign_patient_doctor')
    order by 1
  `);
  console.log("RPCs:", rows);

  const { rows: grants } = await client.query(`
    select routine_name, grantee, privilege_type
    from information_schema.routine_privileges
    where routine_schema = 'public'
      and routine_name in ('lookup_patient_scan', 'assign_patient_doctor')
      and grantee in ('authenticated', 'anon', 'PUBLIC')
    order by 1, 2
  `);
  console.log("Grants:", grants);
  console.log("OK: staff-scan QR RPCs updated");
} catch (error) {
  console.error(
    "Migration failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
