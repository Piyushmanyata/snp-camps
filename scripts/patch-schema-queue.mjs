import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, "..", "supabase", "schema.sql");
let s = fs.readFileSync(schemaPath, "utf8");

s = s.replace(
  "create type public.queue_status as enum ('waiting', 'seen');",
  "create type public.queue_status as enum ('registered', 'waiting', 'seen');",
);

s = s.replace(
  "queue_status public.queue_status not null default 'waiting',\n  seen_at timestamptz,",
  "queue_status public.queue_status not null default 'registered',\n  queued_at timestamptz,\n  seen_at timestamptz,",
);

// register insert: status registered + queued_at null
s = s.replace(
  "created_by, queue_status\n  ) values (",
  "created_by, queue_status, queued_at\n  ) values (",
);

s = s.replace(
  "v_created_by,\n    'waiting'\n  )\n  returning patients.id, patients.reg_no, patients.full_name;",
  "v_created_by,\n    'registered',\n    null\n  )\n  returning patients.id, patients.reg_no, patients.full_name;",
);

if (!s.includes("function public.join_queue")) {
  const inject = `
-- Volunteer check-in: scan QR or enter reg no → join FCFS queue
create or replace function public.join_queue(
  p_patient_id uuid default null,
  p_reg_no integer default null
)
returns table (
  id uuid,
  reg_no integer,
  full_name text,
  queue_status public.queue_status,
  already_in_queue boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.patients%rowtype;
  v_already boolean := false;
begin
  if not public.is_staff() then
    raise exception 'staff only';
  end if;

  if p_patient_id is not null then
    select * into r from public.patients where patients.id = p_patient_id;
  elsif p_reg_no is not null then
    select * into r from public.patients where patients.reg_no = p_reg_no;
  else
    raise exception 'Provide patient id or reg no';
  end if;

  if r.id is null then
    raise exception 'Patient not found';
  end if;

  if r.queue_status = 'seen' then
    return query
    select r.id, r.reg_no, r.full_name, r.queue_status, true;
    return;
  end if;

  if r.queue_status = 'waiting' then
    v_already := true;
  else
    update public.patients
    set queue_status = 'waiting',
        queued_at = coalesce(queued_at, now())
    where patients.id = r.id
    returning * into r;
  end if;

  return query
  select r.id, r.reg_no, r.full_name, r.queue_status, v_already;
end;
$$;

grant execute on function public.join_queue(uuid, integer) to authenticated;

`;
  s = s.replace(
    "-- mark seen on print (staff only)",
    inject + "-- mark seen on print (staff only)",
  );
}

fs.writeFileSync(schemaPath, s);
console.log({
  enum: s.includes("'registered', 'waiting', 'seen'"),
  default: s.includes("default 'registered'"),
  join: s.includes("function public.join_queue"),
  queued_at: s.includes("queued_at timestamptz"),
});
