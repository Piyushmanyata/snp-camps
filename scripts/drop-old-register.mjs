import "./load-env.mjs";
import pg from "pg";

const pwd = process.env.SUPABASE_DB_PASSWORD;
const client = new pg.Client({
  connectionString: `postgresql://postgres:${encodeURIComponent(pwd)}@db.ruklmrzpyutvefancsgo.supabase.co:5432/postgres`,
  ssl: { rejectUnauthorized: false },
});
await client.connect();
await client.query(
  `drop function if exists public.register_patient(uuid, text, text, integer, text, text, text, text, uuid, uuid)`,
);
const r = await client.query(
  `select pg_get_function_identity_arguments(p.oid) as args
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'register_patient'`,
);
console.log("register_patient overloads:", r.rows);
await client.query(
  `update patients set camp_day_id = (
     select id from camp_days d where d.camp_id = patients.camp_id order by day_date limit 1
   ) where camp_day_id is null`,
);
await client.end();
console.log("OK");
