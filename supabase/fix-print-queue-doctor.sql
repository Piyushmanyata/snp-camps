-- v2 flow: print → waiting (queue); scan+doctor → seen (once).
-- Doctor role; printed_at; seen_by.

-- 1) Enum value (run in own transaction before using the label in later statements)
do $$
begin
  alter type public.user_role add value if not exists 'doctor';
exception
  when duplicate_object then null;
end $$;

-- 2) Columns
alter table public.patients
  add column if not exists printed_at timestamptz;

alter table public.patients
  add column if not exists seen_by uuid references public.profiles (id) on delete set null;

alter table public.patients
  add column if not exists checked_in_by uuid references public.profiles (id) on delete set null;

create index if not exists patients_seen_by_idx
  on public.patients (seen_by)
  where seen_by is not null;

create index if not exists patients_checked_in_by_idx
  on public.patients (checked_in_by)
  where checked_in_by is not null;

-- 3) Staff includes doctors
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('admin', 'volunteer', 'doctor')
  );
$$;

create or replace function public.is_doctor()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'doctor'
  );
$$;

grant execute on function public.is_doctor() to authenticated;

-- 4) Print = join queue (not seen)
create or replace function public.mark_patient_printed(p_id uuid)
returns table (
  id uuid,
  reg_no integer,
  full_name text,
  queue_status public.queue_status,
  already_printed boolean
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

  select * into r from public.patients where patients.id = p_id for update;
  if r.id is null then
    raise exception 'Patient not found';
  end if;
  if not exists (
    select 1 from public.camps c
    where c.id = r.camp_id and c.is_active
  ) then
    raise exception 'Patient belongs to an inactive camp';
  end if;

  -- Already printed or further along: keep status; ensure printed_at set
  if r.queue_status in ('waiting', 'seen') then
    v_already := true;
    if r.printed_at is null or r.checked_in_by is null then
      update public.patients
      set printed_at = coalesce(printed_at, now()),
          queued_at = coalesce(queued_at, now()),
          checked_in_by = coalesce(checked_in_by, auth.uid())
      where patients.id = r.id
      returning * into r;
    end if;
    return query
    select r.id, r.reg_no, r.full_name, r.queue_status, v_already;
    return;
  end if;

  -- registered → waiting (in queue)
  update public.patients
  set queue_status = 'waiting',
      queued_at = coalesce(queued_at, now()),
      printed_at = coalesce(printed_at, now()),
      checked_in_by = coalesce(checked_in_by, auth.uid())
  where patients.id = r.id
  returning * into r;

  return query
  select r.id, r.reg_no, r.full_name, r.queue_status, false;
end;
$$;

grant execute on function public.mark_patient_printed(uuid) to authenticated;

-- Keep join_queue as alias of print path for older clients that only need "enter queue"
-- but do NOT mark seen. Prefer mark_patient_printed from app.
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
    select * into r from public.patients where patients.id = p_patient_id for update;
  elsif p_reg_no is not null then
    select * into r from public.patients where patients.reg_no = p_reg_no for update;
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
    if r.printed_at is null or r.queued_at is null or r.checked_in_by is null then
      update public.patients
      set printed_at = coalesce(printed_at, now()),
          queued_at = coalesce(queued_at, now()),
          checked_in_by = coalesce(checked_in_by, auth.uid())
      where patients.id = r.id
      returning * into r;
    end if;
  else
    update public.patients
    set queue_status = 'waiting',
        queued_at = coalesce(queued_at, now()),
        printed_at = coalesce(printed_at, now()),
        checked_in_by = coalesce(checked_in_by, auth.uid())
    where patients.id = r.id
    returning * into r;
  end if;

  return query
  select r.id, r.reg_no, r.full_name, r.queue_status, v_already;
end;
$$;

grant execute on function public.join_queue(uuid, integer) to authenticated;

-- 5) Scan + doctor → seen (once). Doctors force self-assign.
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

  -- Must print first
  if r.queue_status = 'registered' then
    return query
    select
      r.id,
      r.reg_no,
      r.full_name,
      r.queue_status,
      null::uuid,
      null::text,
      false,
      'must_print_first'::text;
    return;
  end if;

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
      printed_at = coalesce(printed_at, now()),
      checked_in_by = coalesce(checked_in_by, auth.uid())
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

-- 6) Legacy mark_patient_seen: block without doctor — force new path
create or replace function public.mark_patient_seen(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Deprecated: use assign_patient_doctor. If caller is a doctor, self-assign.
  if public.is_doctor() then
    perform public.assign_patient_doctor(p_id, null, auth.uid());
    return;
  end if;
  raise exception 'Use assign doctor (scan). Print only puts patient in queue.';
end;
$$;

grant execute on function public.mark_patient_seen(uuid) to authenticated;

-- 7) Lookup helper for scanners (no side effects)
create or replace function public.lookup_patient_scan(
  p_patient_id uuid default null,
  p_reg_no integer default null
)
returns table (
  id uuid,
  reg_no integer,
  full_name text,
  queue_status public.queue_status,
  phone text,
  doctor_id uuid,
  doctor_name text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.patients%rowtype;
  v_doctor_name text;
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

  if not exists (
    select 1 from public.camps c
    where c.id = r.camp_id and c.is_active
  ) then
    raise exception 'Patient belongs to an inactive camp';
  end if;

  if r.seen_by is not null then
    select pr.full_name into v_doctor_name
    from public.profiles pr
    where pr.id = r.seen_by;
  end if;

  return query
  select
    r.id,
    r.reg_no,
    r.full_name,
    r.queue_status,
    r.phone,
    r.seen_by,
    v_doctor_name;
end;
$$;

grant execute on function public.lookup_patient_scan(uuid, integer) to authenticated;
