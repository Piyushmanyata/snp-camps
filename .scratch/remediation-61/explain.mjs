import pg from "pg";
import { randomUUID } from "node:crypto";

const c = new pg.Client({
  connectionString: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
});
await c.connect();
const staff = randomUUID();
await c.query(
  `insert into auth.users (
     id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
     raw_app_meta_data, raw_user_meta_data, created_at, updated_at
   ) values (
     $1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     $2, crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now()
   )`,
  [staff, `${staff}@ex.test`],
);
await c.query(
  `insert into public.profiles (id, role, full_name, email)
   values ($1, 'volunteer', 'V', $2)`,
  [staff, `${staff}@ex.test`],
);
await c.query("begin");
await c.query("select pg_advisory_xact_lock(918273645)");
await c.query(`update public.camps set is_active = false where is_active`);
const campId = randomUUID();
const dayId = randomUUID();
await c.query(
  `insert into public.camps (id, name, is_active, venue)
   values ($1, 'Explain camp', true, 'explain-test')`,
  [campId],
);
await c.query(
  `insert into public.camp_days (id, camp_id, day_date, seat_limit)
   values ($1, $2, '2099-08-01', 50)`,
  [dayId, campId],
);
for (let i = 0; i < 30; i += 1) {
  await c.query(
    `insert into public.patients (camp_id, camp_day_id, full_name, queue_status, created_by)
     values ($1, $2, $3, 'registered', $4)`,
    [campId, dayId, `Suresh Patient ${i}`, staff],
  );
}
await c.query(
  `insert into public.patients (camp_id, camp_day_id, full_name, queue_status, created_by)
   values ($1, $2, 'Priya Sharma', 'registered', $3)`,
  [campId, dayId, staff],
);
await c.query("commit");

async function asStaff(fn) {
  await c.query("begin");
  try {
    await c.query(
      `select set_config('request.jwt.claim.role', 'authenticated', true)`,
    );
    await c.query(
      `select set_config('request.jwt.claim.sub', $1, true)`,
      [staff],
    );
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ role: "authenticated", sub: staff }),
    ]);
    const result = await fn();
    await c.query("commit");
    return result;
  } catch (err) {
    await c.query("rollback");
    throw err;
  }
}

const prefix = await asStaff(async () => {
  const { rows } = await c.query(
    `explain (analyze, buffers, format text)
     select * from public.search_registered_patients($1, 'sure', 10)`,
    [campId],
  );
  return rows.map((r) => r["QUERY PLAN"]).join("\n");
});
const fuzzy = await asStaff(async () => {
  const { rows } = await c.query(
    `explain (analyze, buffers, format text)
     select * from public.search_registered_patients($1, 'pirya sharma', 10)`,
    [campId],
  );
  return rows.map((r) => r["QUERY PLAN"]).join("\n");
});
console.log("=== PREFIX sure ===");
console.log(prefix);
console.log("=== FUZZY pirya sharma ===");
console.log(fuzzy);
await c.query(`update public.camps set is_active = false where id = $1`, [campId]);
await c.end();
