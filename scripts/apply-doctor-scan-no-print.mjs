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

const sqlPath = path.join(
  __dirname,
  "..",
  "supabase",
  "fix-doctor-scan-no-print.sql",
);
const sql = fs.readFileSync(sqlPath, "utf8");

const c = new Client({
  connectionString: `postgresql://postgres:${encodeURIComponent(pwd)}@db.${ref}.supabase.co:5432/postgres`,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20000,
});

await c.connect();
await c.query(sql);
console.log("assign_patient_doctor: registered patients can be scanned without print");
await c.end();
console.log("OK");
