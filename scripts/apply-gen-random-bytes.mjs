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
    // Local/dev TLS interception or missing system CA — still encrypted.
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
  path.join(__dirname, "..", "supabase", "fix-gen-random-bytes.sql"),
  "utf8",
);

const client = await connect();
if (!client) {
  console.error("Could not connect to Supabase Postgres");
  process.exit(1);
}

try {
  const result = await client.query(sql);
  // Last statement is the smoke check SELECT
  const rows = Array.isArray(result) ? result.at(-1)?.rows : result.rows;
  console.log("gen_random_bytes hotfix applied");
  console.log("smoke:", rows?.[0] ?? rows);

  const pathCheck = await client.query(`
    select
      p.proname,
      pg_get_function_identity_arguments(p.oid) as args,
      p.proconfig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('register_patient_authorized_impl', 'register_patient')
    order by p.proname
  `);
  console.log(
    "function search_path configs:",
    pathCheck.rows.map((r) => `${r.proname}(${r.args}) => ${JSON.stringify(r.proconfig)}`).join(" | "),
  );
} catch (error) {
  console.error("Migration failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
