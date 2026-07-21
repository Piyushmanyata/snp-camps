-- Doctors may scan registered patients without print first.
-- Desk print still joins the queue for volunteers; doctor scan → seen directly.

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'patients_created_by_profiles_fkey'
  ) then
    alter table public.patients
      add constraint patients_created_by_profiles_fkey
      foreign key (created_by) references public.profiles(id) on delete set null;
  end if;
end $$;

notify pgrst, 'reload schema';

create or replace function public.assign_patient_doctor(
  p_patient_id uuid default null,
  p_reg_no integer default null,
  p_doctor_id uuid default null
)
returns table (
  id uuid,
  reg_no integer,
  full_name text,
  queue_status public.queue_status,
  doctor_id uuid,
  doctor_name text,
  already_seen boolean,
  error_code text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.patients%rowtype;
  v_doctor_id uuid;
  v_doctor_name text;
  v_caller_role public.user_role;
  v_doctor_exists boolean;
begin
  if not public.is_staff() then
    raise exception 'staff only';
  end if;

  select p.role into v_caller_role
  from public.profiles p
  where p.id = auth.uid();

  if p_patient_id is not null then
    select * into r from public.patients where patients.id = p_patient_id for update;
  elsif p_reg_no is not null then
    select * into r from public.patients where patients.reg_no = p_reg_no for update;
  else
    raise exception 'Provide patient id or reg no';
  end if;

  if r.id is null then
    raise exception 'Patient not found';
  end if;

  -- Already seen: hard block (no update)
  if r.queue_status = 'seen' then
    select pr.full_name into v_doctor_name
    from public.profiles pr
    where pr.id = r.seen_by;
    return query
    select
      r.id,
      r.reg_no,
      r.full_name,
      r.queue_status,
      r.seen_by,
      coalesce(v_doctor_name, 'Unknown'),
      true,
      'already_seen'::text;
    return;
  end if;

  -- registered: doctors (and volunteers/admin with a doctor picked) may assign
  -- without a prior print. Print remains optional for desk queue tracking.

  -- Resolve doctor
  if v_caller_role = 'doctor' then
    v_doctor_id := auth.uid();
  elsif p_doctor_id is not null then
    v_doctor_id := p_doctor_id;
  else
    return query
    select
      r.id,
      r.reg_no,
      r.full_name,
      r.queue_status,
      null::uuid,
      null::text,
      false,
      'doctor_required'::text;
    return;
  end if;

  select exists (
    select 1 from public.profiles pr
    where pr.id = v_doctor_id and pr.role = 'doctor'
  ) into v_doctor_exists;

  if not v_doctor_exists then
    raise exception 'Invalid doctor';
  end if;

  select pr.full_name into v_doctor_name
  from public.profiles pr
  where pr.id = v_doctor_id;

  update public.patients
  set queue_status = 'seen',
      seen_at = coalesce(seen_at, now()),
      seen_by = v_doctor_id,
      queued_at = coalesce(queued_at, now()),
      -- printed_at stays null if never printed; do not invent a print
      printed_at = printed_at
  where patients.id = r.id
  returning * into r;

  return query
  select
    r.id,
    r.reg_no,
    r.full_name,
    r.queue_status,
    r.seen_by,
    coalesce(v_doctor_name, 'Doctor'),
    false,
    null::text;
end;
$$;

grant execute on function public.assign_patient_doctor(uuid, integer, uuid) to authenticated;
