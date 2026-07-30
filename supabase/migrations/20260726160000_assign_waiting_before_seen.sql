-- #57 — Enforce lifecycle registered → waiting → seen in assign_patient_doctor.
-- First assignment of a registered patient returns check_in_required and leaves
-- the row unchanged. Only waiting may become seen. already_seen remains terminal.
-- Rollback: replace with a function that still rejects registered → seen
-- (never re-authorize that transition).

CREATE OR REPLACE FUNCTION public.assign_patient_doctor(
  p_patient_id uuid DEFAULT NULL::uuid,
  p_reg_no integer DEFAULT NULL::integer,
  p_doctor_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(
  id uuid,
  reg_no integer,
  full_name text,
  queue_status public.queue_status,
  doctor_id uuid,
  doctor_name text,
  already_seen boolean,
  error_code text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
declare
  r public.patients%rowtype;
  v_caller_role public.user_role;
  v_doctor_id uuid;
  v_doctor_name text;
begin
  select p.role
  into v_caller_role
  from public.profiles p
  where p.id = (select auth.uid())
    and p.role in ('admin', 'volunteer', 'doctor')
    and p.disabled_at is null;

  if v_caller_role is null then
    raise exception 'active staff only';
  end if;

  if p_patient_id is not null then
    select *
    into r
    from public.patients p
    where p.id = p_patient_id
    for update;
  elsif p_reg_no is not null then
    select *
    into r
    from public.patients p
    where p.reg_no = p_reg_no
    for update;
  else
    raise exception 'Provide patient id or reg no';
  end if;

  if r.id is null then
    raise exception 'Patient not found';
  end if;

  if not exists (
    select 1
    from public.camps c
    where c.id = r.camp_id
      and c.is_active
  ) then
    raise exception 'Patient belongs to an inactive camp';
  end if;

  -- A completed assignment is immutable, including its original doctor.
  if r.queue_status = 'seen' then
    select p.full_name
    into v_doctor_name
    from public.profiles p
    where p.id = r.seen_by;

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

  -- #57: check-in is a separate arrival event; never synthesize waiting → seen.
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
      'check_in_required'::text;
    return;
  end if;

  if r.queue_status is distinct from 'waiting' then
    raise exception 'Unsupported patient queue status';
  end if;

  if v_caller_role = 'doctor' then
    v_doctor_id := (select auth.uid());
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

  select p.full_name
  into v_doctor_name
  from public.profiles p
  where p.id = v_doctor_id
    and p.role = 'doctor'
    and p.disabled_at is null;

  if not found then
    raise exception 'Invalid or disabled doctor';
  end if;

  -- Preserve original queued_at / checked_in_by; do not backfill check-in to the doctor.
  update public.patients p
  set queue_status = 'seen',
      seen_at = now(),
      seen_by = v_doctor_id
  where p.id = r.id
  returning p.* into r;

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

COMMENT ON FUNCTION public.assign_patient_doctor(uuid, integer, uuid) IS
  'Staff QR scan: mark waiting patient seen. Rejects registered (check_in_required). Terminal already_seen keeps original doctor.';
