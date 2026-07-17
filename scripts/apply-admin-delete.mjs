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
  path.join(__dirname, "..", "supabase", "fix-admin-delete-patients.sql"),
  "utf8",
);
await client.query(sql);
const pol = await client.query(
  `select policyname, cmd from pg_policies where tablename = 'patients' order by 1`,
);
console.log(
  "policies:",
  pol.rows.map((r) => `${r.policyname}(${r.cmd})`).join(", "),
);
await client.end();
console.log("OK");
