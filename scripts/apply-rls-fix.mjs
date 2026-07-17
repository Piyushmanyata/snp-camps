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
  for (const c of configs) {
    const client = new Client({
      connectionString: c.connectionString,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 15000,
    });
    try {
      await client.connect();
      console.log("CONNECTED via", c.label);
      return client;
    } catch (e) {
      console.log("FAIL", c.label, String(e.message).slice(0, 140));
      try {
        await client.end();
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

async function main() {
  const client = await connect();
  if (!client) process.exit(1);

  const sqlPath = path.join(__dirname, "..", "supabase", "fix-patients-rls.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");

  try {
    await client.query(sql);
    console.log("FIX APPLIED OK");

    const pol = await client.query(
      `select policyname, cmd from pg_policies where tablename = 'patients' order by 1`,
    );
    console.log(
      "policies:",
      pol.rows.map((r) => `${r.policyname}(${r.cmd})`).join(", "),
    );

    const camp = await client.query(
      `select id from camps where is_active = true limit 1`,
    );
    if (!camp.rows[0]) {
      console.error("No active camp");
      process.exit(3);
    }

    const r = await client.query(
      `select * from register_patient($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        camp.rows[0].id,
        "RLS Test Patient",
        "M",
        45,
        null,
        "9999999999",
        null,
        "1234",
        null,
        null,
      ],
    );
    console.log("register_patient ok:", r.rows[0]);
    await client.query(`delete from patients where full_name = $1`, [
      "RLS Test Patient",
    ]);
    console.log("cleaned test row");
  } catch (e) {
    console.error("ERR:", e.message);
    process.exit(2);
  } finally {
    await client.end();
  }
}

main();
