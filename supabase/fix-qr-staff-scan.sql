-- Staff-scan QR only (volunteers / doctors). No patient QR login.
-- Ensures lookup + assign RPCs are healthy and executable by authenticated staff.

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

comment on function public.lookup_patient_scan(uuid, integer) is
  'Staff-only patient lookup for QR/reg scan. No side effects. QR is not for patient login.';

revoke all on function public.lookup_patient_scan(uuid, integer) from public;
revoke all on function public.lookup_patient_scan(uuid, integer) from anon;
grant execute on function public.lookup_patient_scan(uuid, integer) to authenticated;

-- Doctors may scan registered patients without print first.
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

  if not exists (
    select 1 from public.camps c
    where c.id = r.camp_id and c.is_active
  ) then
    raise exception 'Patient belongs to an inactive camp';
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

comment on function public.assign_patient_doctor(uuid, integer, uuid) is
  'Staff QR scan: assign doctor and mark seen. Doctors may scan without prior print.';

revoke all on function public.assign_patient_doctor(uuid, integer, uuid) from public;
revoke all on function public.assign_patient_doctor(uuid, integer, uuid) from anon;
grant execute on function public.assign_patient_doctor(uuid, integer, uuid) to authenticated;
