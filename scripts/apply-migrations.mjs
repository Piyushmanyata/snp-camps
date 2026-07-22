import pg from "pg";
import fs from "node:fs";
import path from "node:path";

const { Client } = pg;

const pass = encodeURIComponent(process.env.SUPABASE_DB_PASSWORD || "");
const ref = "ruklmrzpyutvefancsgo";
const user = `postgres.${ref}`;
const host = "aws-1-ap-south-1.pooler.supabase.com";
const port = 5432;

const connectionString = `postgres://${user}:${pass}@${host}:${port}/postgres`;

console.log(`Connecting to Supabase Postgres (${host}:${port})...`);
const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });

async function applyMigrations() {
  try {
    await client.connect();
    console.log("Connected successfully to Supabase Postgres!");

    const migrationsDir = path.join(process.cwd(), "supabase", "migrations");
    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort();

    for (const file of files) {
      console.log(`Executing migration: ${file}...`);
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      await client.query(sql);
      console.log(`Applied: ${file}`);
    }

    console.log("All migrations applied successfully!");

    // Verify profiles columns
    const colRes = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'profiles';");
    console.log("Updated profiles columns:", colRes.rows.map(r => r.column_name));

  } catch (err) {
    console.error("Migration error:", err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

applyMigrations();
