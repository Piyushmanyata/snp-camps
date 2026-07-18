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

function client() {
  return new Client({
    connectionString: `postgresql://postgres:${encodeURIComponent(pwd)}@db.${ref}.supabase.co:5432/postgres`,
ssl: {
      rejectUnauthorized: true,
      ...(process.env.SUPABASE_DB_CA ? { ca: process.env.SUPABASE_DB_CA } : {}),
    },
    connectionTimeoutMillis: 20000,
  });
}

const sqlPath = path.join(
  __dirname,
  "..",
  "supabase",
  "fix-print-queue-doctor.sql",
);
const full = fs.readFileSync(sqlPath, "utf8");

// Step 1: enum alone (must commit before using 'doctor' label)
{
  const c = client();
  await c.connect();
  try {
    await c.query(`
      do $$
      begin
        alter type public.user_role add value if not exists 'doctor';
      exception
        when duplicate_object then null;
      end $$;
    `);
    console.log("enum doctor ok");
  } catch (e) {
    console.error("enum step:", e.message);
    process.exit(1);
  }
  await c.end();
}

// Step 2: rest of migration
{
  const c = client();
  await c.connect();
  // Skip the first DO block (enum) — already applied
  const rest = full.replace(
    /-- 1\) Enum value[\s\S]*?end \$\$;\s*/,
    "",
  );
  await c.query(rest);
  console.log("functions + columns applied");

  const roles = await c.query(
    `select enumlabel from pg_enum e
     join pg_type t on t.oid = e.enumtypid
     where t.typname = 'user_role'
     order by enumsortorder`,
  );
  console.log(
    "user_role:",
    roles.rows.map((r) => r.enumlabel).join(", "),
  );

  const cols = await c.query(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'patients'
       and column_name in ('printed_at', 'seen_by')
     order by column_name`,
  );
  console.log(
    "patient cols:",
    cols.rows.map((r) => r.column_name).join(", "),
  );

  await c.end();
  console.log("OK");
}
