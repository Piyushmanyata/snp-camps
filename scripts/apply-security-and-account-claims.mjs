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

const sql = fs.readFileSync(
  path.join(__dirname, "..", "supabase", "fix-security-and-account-claims.sql"),
  "utf8",
);

const client = new Client({
  connectionString: `postgresql://postgres:${encodeURIComponent(pwd)}@db.${ref}.supabase.co:5432/postgres`,
  ssl: {
    rejectUnauthorized: true,
    ...(process.env.SUPABASE_DB_CA ? { ca: process.env.SUPABASE_DB_CA } : {}),
  },
  connectionTimeoutMillis: 20000,
});

try {
  await client.connect();
  await client.query(sql);
  console.log("Security, account-claim, and queue hardening applied");
} catch (error) {
  console.error("Migration failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
