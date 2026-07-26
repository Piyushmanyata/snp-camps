import pg from "pg";

const c = new pg.Client({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
});
await c.connect();
await c.query(`
  delete from public.patients where camp_id in (
    select id from public.camps where venue = 'boundary-test'
  )`);
await c.query(`
  delete from public.camp_days where camp_id in (
    select id from public.camps where venue = 'boundary-test'
  )`);
await c.query(`delete from public.camps where venue = 'boundary-test'`);
await c.query(`delete from public.profiles where email like '%@boundary.test'`);
await c.query(`delete from auth.users where email like '%@boundary.test'`);
const { rows } = await c.query(
  `select count(*)::int as n from public.camps where is_active`,
);
console.log("active_camps", rows[0].n);
await c.end();
