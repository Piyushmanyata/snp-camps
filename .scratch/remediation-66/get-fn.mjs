import pg from "pg";
const c = new pg.Client({
  connectionString:
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
});
await c.connect();
const r = await c.query(
  `select pg_get_functiondef('public.upsert_camp_day(uuid,date,integer,uuid)'::regprocedure) as def`,
);
console.log(r.rows[0].def);
await c.end();
