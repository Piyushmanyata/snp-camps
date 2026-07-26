import pg from "pg";
const c = new pg.Client({
  connectionString:
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
});
await c.connect();
const camps = await c.query(
  `select id, name, is_active from public.camps order by name`,
);
console.log("camps:", camps.rows.length, camps.rows.slice(0, 30));
// Soft-clean only test-named camps left by failed concurrent runs
const del = await c.query(`
  with doomed as (
    select id from public.camps
    where name ~* '^(DB test|Cap-conc|Likely|Cap |check-in|Aadhaar|SMS|Status|Staff|Boundary|Assign|Dup)'
       or venue in ('cap-conc','db-test','likely-dup-conc','other')
  ),
  p as (delete from public.patients where camp_id in (select id from doomed) returning 1),
  d as (delete from public.camp_days where camp_id in (select id from doomed) returning 1)
  delete from public.camps where id in (select id from doomed)
  returning id, name
`);
console.log("deleted camps:", del.rows.length);
const after = await c.query(
  `select id, name, is_active from public.camps order by name`,
);
console.log("remaining:", after.rows);
await c.end();
