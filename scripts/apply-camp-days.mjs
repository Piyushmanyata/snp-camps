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

const client = new Client({
  connectionString: `postgresql://postgres:${encodeURIComponent(pwd)}@db.${ref}.supabase.co:5432/postgres`,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20000,
});

await client.connect();
const sql = fs.readFileSync(
  path.join(__dirname, "..", "supabase", "fix-camp-days.sql"),
  "utf8",
);
try {
  await client.query(sql);
  console.log("APPLIED");
} catch (e) {
  console.error("ERR:", e.message);
  process.exit(2);
}

const days = await client.query(
  `select d.day_date, d.seat_limit, count(p.id)::int as taken
   from camp_days d left join patients p on p.camp_day_id = d.id
   group by d.id order by d.day_date`,
);
console.log("days:", days.rows);

const fn = await client.query(
  `select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and proname in
   ('camp_day_stats','upsert_camp_day','change_camp_day','register_patient','delete_camp_day')
   order by 1`,
);
console.log(
  "fns:",
  fn.rows.map((r) => r.proname).join(", "),
);

await client.end();
console.log("OK");
