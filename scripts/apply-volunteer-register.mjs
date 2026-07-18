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
      label: "strict",
      ssl: {
        rejectUnauthorized: true,
        ...(process.env.SUPABASE_DB_CA ? { ca: process.env.SUPABASE_DB_CA } : {}),
      },
    },
    { label: "tls-relaxed", ssl: { rejectUnauthorized: false } },
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
  path.join(__dirname, "..", "supabase", "fix-volunteer-register.sql"),
  "utf8",
);

const client = await connect();
if (!client) {
  console.error("Could not connect to Supabase Postgres");
  process.exit(1);
}

try {
  await client.query(sql);

  const { rows: grants } = await client.query(`
    select routine_name, grantee, privilege_type
    from information_schema.routine_privileges
    where routine_schema = 'public'
      and routine_name in ('register_patient', 'volunteer_my_counts', 'is_staff')
      and grantee in ('authenticated', 'anon', 'PUBLIC', 'service_role')
    order by 1, 2
  `);
  console.log("Grants:", grants);

  const { rows: idx } = await client.query(`
    select indexname from pg_indexes
    where schemaname = 'public'
      and indexname = 'patients_created_by_created_at_idx'
  `);
  console.log("Index:", idx);
  console.log("OK: volunteer register / desk grants updated");
} catch (error) {
  console.error(
    "Migration failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
