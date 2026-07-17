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
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
  });
}

// Step 1: add enum value alone (must commit before use)
{
  const c = client();
  await c.connect();
  try {
    await c.query(`
      do $$
      begin
        alter type public.queue_status add value if not exists 'registered';
      exception
        when duplicate_object then null;
      end $$;
    `);
    console.log("enum step ok");
  } catch (e) {
    console.error("enum step:", e.message);
  }
  await c.end();
}

// Step 2: rest of migration in a new connection/transaction
{
  const c = client();
  await c.connect();
  const sql = `
alter table public.patients
  alter column queue_status set default 'registered';

alter table public.patients
  add column if not exists queued_at timestamptz;

create index if not exists patients_camp_queue_order_idx
  on public.patients (camp_id, queue_status, queued_at nulls last, created_at);
`;
  await c.query(sql);

  // functions from fix file — skip the enum DO block at top
  const full = fs.readFileSync(
    path.join(__dirname, "..", "supabase", "fix-queue-checkin.sql"),
    "utf8",
  );
  // From "-- Default for new rows" or from register_patient
  const fnStart = full.indexOf("create or replace function public.register_patient");
  if (fnStart < 0) throw new Error("register_patient not in fix file");
  await c.query(full.slice(fnStart));
  console.log("functions applied");

  const enums = await c.query(
    `select enumlabel from pg_enum e
     join pg_type t on t.oid = e.enumtypid
     where t.typname = 'queue_status'
     order by enumsortorder`,
  );
  console.log(
    "enum:",
    enums.rows.map((r) => r.enumlabel).join(", "),
  );

  const def = await c.query(
    `select column_default from information_schema.columns
     where table_schema = 'public' and table_name = 'patients' and column_name = 'queue_status'`,
  );
  console.log("default:", def.rows[0]?.column_default);

  await c.end();
  console.log("OK");
}
