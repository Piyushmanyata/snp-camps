-- Migration: Volunteer Checked-In KPI Fix

ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS checked_in_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS patients_checked_in_by_idx ON public.patients(checked_in_by) WHERE checked_in_by IS NOT NULL;

-- 1) join_queue: update checked_in_by = coalesce(checked_in_by, auth.uid()) when status set to 'waiting'
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


-- 2) mark_patient_printed: set checked_in_by = coalesce(checked_in_by, auth.uid()) when status set to 'waiting'
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

  -- Already printed or further along: keep status; ensure printed_at and checked_in_by set
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


-- 3) assign_patient_doctor: set checked_in_by = coalesce(checked_in_by, auth.uid())
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


-- 4) volunteer_my_counts: count created_by = volunteer_id OR checked_in_by = volunteer_id
create or replace function public.volunteer_my_counts(p_since timestamptz)
returns table (
  total bigint,
  today bigint,
  waiting bigint,
  seen bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*)::bigint,
    count(*) filter (where p.created_at >= p_since)::bigint,
    count(*) filter (where p.queue_status = 'waiting')::bigint,
    count(*) filter (where p.queue_status = 'seen')::bigint
  from public.patients p
  where (p.created_by = auth.uid() or p.checked_in_by = auth.uid())
    and (
      -- Prefer active camp when one exists; else all camps
      not exists (select 1 from public.camps c where c.is_active)
      or p.camp_id = (select c.id from public.camps c where c.is_active limit 1)
    )
    and exists (
      select 1 from public.profiles pr
      where pr.id = auth.uid() and pr.role in ('admin', 'volunteer', 'doctor')
    );
$$;

revoke all on function public.volunteer_my_counts(timestamptz) from public, anon;
grant execute on function public.volunteer_my_counts(timestamptz) to authenticated;


-- 5) staff_person_kpis: count created_by = volunteer_id OR checked_in_by = volunteer_id for volunteers
create or replace function public.staff_person_kpis(
  p_user_id uuid,
  p_role text,
  p_camp_id uuid default null,
  p_since timestamptz default null
)
returns table (
  total bigint,
  today bigint,
  waiting bigint,
  seen bigint,
  label text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_since timestamptz := coalesce(p_since, date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata');
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  -- Admin can view anyone; others only themselves matching role
  if not public.is_admin() then
    if auth.uid() is distinct from p_user_id then
      raise exception 'forbidden';
    end if;
    if not exists (
      select 1 from public.profiles pr
      where pr.id = auth.uid() and pr.role = p_role
    ) then
      raise exception 'forbidden';
    end if;
  end if;

  if p_role = 'doctor' then
    return query
    select
      count(*)::bigint as total,
      count(*) filter (where p.seen_at >= v_since)::bigint as today,
      0::bigint as waiting,
      count(*)::bigint as seen,
      'Patients seen'::text as label
    from public.patients p
    where p.seen_by = p_user_id
      and p.queue_status = 'seen'
      and (p_camp_id is null or p.camp_id = p_camp_id);
  elsif p_role = 'volunteer' then
    return query
    select
      count(*)::bigint as total,
      count(*) filter (where p.created_at >= v_since)::bigint as today,
      count(*) filter (where p.queue_status = 'waiting')::bigint as waiting,
      count(*) filter (where p.queue_status = 'seen')::bigint as seen,
      'Patients registered'::text as label
    from public.patients p
    where (p.created_by = p_user_id or p.checked_in_by = p_user_id)
      and (p_camp_id is null or p.camp_id = p_camp_id);
  else
    raise exception 'invalid role';
  end if;
end;
$$;

revoke all on function public.staff_person_kpis(uuid, text, uuid, timestamptz) from public, anon;
grant execute on function public.staff_person_kpis(uuid, text, uuid, timestamptz) to authenticated;
