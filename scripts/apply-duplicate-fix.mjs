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

const client = new Client({
  connectionString: `postgresql://postgres:${encodeURIComponent(pwd)}@db.${ref}.supabase.co:5432/postgres`,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});

await client.connect();
const sql = fs.readFileSync(
  path.join(__dirname, "..", "supabase", "fix-duplicate-register.sql"),
  "utf8",
);
await client.query(sql);

// smoke: ensure function exists
const fn = await client.query(
  `select pg_get_functiondef(p.oid) as def
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'register_patient'
   limit 1`,
);
const def = fn.rows[0]?.def || "";
console.log("has dup check:", def.includes("Already registered"));
await client.end();
console.log("OK");
