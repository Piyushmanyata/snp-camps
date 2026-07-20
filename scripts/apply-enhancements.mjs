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
  console.error("Missing SUPABASE_DB_PASSWORD in .env.local");
  process.exit(1);
}

const dbUrl = `postgresql://postgres:${encodeURIComponent(pwd)}@db.${ref}.supabase.co:5432/postgres`;

const sqlFiles = [
  "fix-security-and-account-claims.sql",
  "security-followup.sql",
  "fix-camp-days.sql",
  "fix-change-day-queue-lock.sql",
  "fix-ambiguous-and-delete-camp.sql",
  "fix-print-queue-doctor.sql",
  "lean-perf.sql",
  "release-hardening.sql",
  "fix-registration-contract.sql",
  "optimization-hardening.sql",
  "optimization-registration-guard.sql",
  "performance-snapshot.sql",
];

async function main() {
  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
  });

  await client.connect();
  console.log("Connected to Supabase DB. Applying migrations...");

  // Apply set_active_camp function update from schema.sql
  console.log("Updating set_active_camp function...");
  const setActiveCampSql = `
    create or replace function public.set_active_camp(p_camp_id uuid)
    returns void
    language plpgsql
    security definer
    set search_path = public
    as $$
    begin
      if not public.is_admin() then
        raise exception 'admin only';
      end if;
      if not exists (select 1 from public.camps where id = p_camp_id) then
        raise exception 'Camp not found';
      end if;
      update public.camps set is_active = false where is_active = true;
      update public.camps set is_active = true where id = p_camp_id;
    end;
    $$;
    grant execute on function public.set_active_camp(uuid) to authenticated;
  `;
  try {
    await client.query(setActiveCampSql);
    console.log("Successfully updated set_active_camp function");
  } catch (e) {
    console.error("Error updating set_active_camp function:", e.message);
    await client.end();
    process.exit(1);
  }

  for (const file of sqlFiles) {
    const filePath = path.join(__dirname, "..", "supabase", file);
    if (!fs.existsSync(filePath)) {
      console.warn(`Skipping missing file: ${file}`);
      continue;
    }

    console.log(`Applying ${file}...`);
    const sql = fs.readFileSync(filePath, "utf8");
    try {
      await client.query(sql);
      console.log(`Successfully applied ${file}`);
    } catch (e) {
      console.error(`Error applying ${file}:`, e.message);
      await client.end();
      process.exit(1);
    }
  }

  await client.end();
  console.log("Database migrations successfully applied!");
}

main().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
