-- Enforce-only security and workflow hardening.
-- Apply after 20260722000000_disabled_staff_expand.sql and the matching app
-- deployment. The preflight refuses to run if the expand step is missing.
--
-- Forward-only rollback guidance: correct an issue with another migration.
-- Do not delete disabled_at or restore broad patient grants until every policy
-- and function that depends on this migration has first been replaced safely.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

select pg_advisory_xact_lock(
  hashtext('snp-camps:20260722010000_production_hardening')
);

-- Abort before any DDL if this is not the schema version this migration was
-- reviewed against. This protects the forward migration from silent drift.
do $preflight$
declare
  v_drift text;
  v_signature text;
begin
  select string_agg(
    format('%I.%I expected %s', e.table_name, e.column_name, e.type_oid::regtype),
    ', '
    order by e.table_name, e.column_name
  )
  into v_drift
  from (
    values
      ('profiles', 'id', 'uuid'::regtype),
      ('profiles', 'role', 'public.user_role'::regtype),
      ('profiles', 'disabled_at', 'timestamptz'::regtype),
      ('patients', 'id', 'uuid'::regtype),
      ('patients', 'user_id', 'uuid'::regtype),
      ('patients', 'camp_id', 'uuid'::regtype),
      ('patients', 'camp_day_id', 'uuid'::regtype),
      ('patients', 'reg_no', 'integer'::regtype),
      ('patients', 'full_name', 'text'::regtype),
      ('patients', 'phone', 'text'::regtype),
      ('patients', 'queue_status', 'public.queue_status'::regtype),
      ('patients', 'queued_at', 'timestamptz'::regtype),
      ('patients', 'printed_at', 'timestamptz'::regtype),
      ('patients', 'seen_at', 'timestamptz'::regtype),
      ('patients', 'seen_by', 'uuid'::regtype),
      ('patients', 'checked_in_by', 'uuid'::regtype),
      ('patients', 'registration_request_id', 'uuid'::regtype),
      ('patients', 'account_provisioning_token', 'text'::regtype)
  ) as e(table_name, column_name, type_oid)
  left join pg_catalog.pg_namespace n
    on n.nspname = 'public'
  left join pg_catalog.pg_class c
    on c.relnamespace = n.oid
   and c.relname = e.table_name
   and c.relkind in ('r', 'p')
  left join pg_catalog.pg_attribute a
    on a.attrelid = c.oid
   and a.attname = e.column_name
   and a.attnum > 0
   and not a.attisdropped
  where a.attname is null or a.atttypid <> e.type_oid;

  if v_drift is not null then
    raise exception 'Production hardening preflight failed: %', v_drift;
  end if;

  foreach v_signature in array array[
    'public.is_staff()',
    'public.is_admin()',
    'public.is_doctor()',
    'public.register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid)',
    'public.doctor_recent_patients(uuid,integer)',
    'public.app_database_contract()',
    'public.change_camp_day(uuid,uuid)',
    'public.assign_patient_doctor(uuid,integer,uuid)',
    'public.mark_patient_printed(uuid)',
    'public.lookup_patient_scan(uuid,integer)',
    'public.doctor_my_counts(uuid,timestamptz)',
    'public.volunteer_my_counts(timestamptz)',
    'public.staff_person_kpis(uuid,text,uuid,timestamptz)'
  ] loop
    if to_regprocedure(v_signature) is null then
      raise exception 'Production hardening preflight failed: missing function %', v_signature;
    end if;
  end loop;
end
$preflight$;

-- Database "staff" means the operational desk roles. Doctors deliberately
-- receive only the dedicated lookup/assignment RPCs below.
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.role in ('admin', 'volunteer')
      and p.disabled_at is null
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'admin'
      and p.disabled_at is null
  );
$$;

create or replace function public.is_doctor()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'doctor'
      and p.disabled_at is null
  );
$$;

revoke execute on function public.is_staff() from public, anon;
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.is_doctor() from public, anon;
grant execute on function public.is_staff() to authenticated, service_role;
grant execute on function public.is_admin() to authenticated, service_role;
grant execute on function public.is_doctor() to authenticated, service_role;

-- A verified patient with no desk-created row is beginning self-registration,
-- not encountering an error. Returning null lets both claim-or-register flows
-- distinguish that case while retaining hard failures for ambiguous matches.
create or replace function public.link_patient_phone(p_phone text)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_phone10 text;
  v_count integer;
  v_patient_id uuid;
  v_auth_phone text;
  v_phone_confirmed_at timestamptz;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if not exists (
    select 1
    from public.profiles
    where id = auth.uid() and role = 'patient'
  ) then
    raise exception 'Patient account required';
  end if;

  v_phone10 := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10);
  if length(v_phone10) <> 10 then raise exception 'Valid phone required'; end if;

  select u.phone, u.phone_confirmed_at
  into v_auth_phone, v_phone_confirmed_at
  from auth.users u
  where u.id = auth.uid();

  if
    v_phone_confirmed_at is null
    or v_auth_phone is distinct from '+91' || v_phone10
  then
    raise exception 'Use the Indian phone number verified for this account';
  end if;

  select count(*)::int, (array_agg(p.id order by p.id))[1]
  into v_count, v_patient_id
  from public.patients p
  join public.camps c on c.id = p.camp_id and c.is_active
  where p.user_id is null
    and p.phone_normalized = v_phone10;

  if v_count = 0 then return null; end if;
  if v_count > 1 then
    raise exception 'Multiple registrations found; ask the desk to link your account';
  end if;

  update public.patients
  set user_id = auth.uid()
  where id = v_patient_id and user_id is null;
  if not found then raise exception 'Registration was already linked'; end if;
  return v_patient_id;
end;
$$;

revoke all on function public.link_patient_phone(text) from public, anon;
grant execute on function public.link_patient_phone(text) to authenticated, service_role;

-- Profiles contain private contact details. Every authenticated user can read
-- their own profile; only active admins can read the staff directory.
drop policy if exists "authenticated read permitted profiles" on public.profiles;
drop policy if exists "read own profile" on public.profiles;

create policy "authenticated read permitted profiles"
on public.profiles
for select
to authenticated
using (
  id = (select auth.uid())
  or (select public.is_admin())
);

-- Profiles are server-managed. A broad UPDATE grant would let a disabled
-- account use an unexpired JWT to clear disabled_at or change its own role.
drop policy if exists "authenticated update permitted profiles" on public.profiles;
drop policy if exists "update own profile or admin" on public.profiles;
revoke all privileges on table public.profiles from anon, authenticated;
grant select on table public.profiles to authenticated;

-- Patients retain their own record. Active admins can inspect all camps and
-- volunteers can operate only the active-camp desk. Doctors use dedicated
-- safe RPCs and never receive direct patient-table access.
drop policy if exists "authenticated read permitted patients" on public.patients;
drop policy if exists "staff select patients" on public.patients;
drop policy if exists "patient read own" on public.patients;

create policy "authenticated read permitted patients"
on public.patients
for select
to authenticated
using (
  user_id = (select auth.uid())
  or (select public.is_admin())
  or (
    (select public.is_staff())
    and exists (
      select 1
      from public.camps c
      where c.id = patients.camp_id
        and c.is_active
    )
  )
);

-- Internal idempotency/provisioning columns are server-only. A table-level
-- SELECT grant would bypass column isolation through PostgREST.
revoke select on table public.patients from authenticated;

grant select (
  id,
  user_id,
  camp_id,
  reg_no,
  full_name,
  gender,
  age,
  address,
  phone,
  email,
  aadhaar_last4,
  queue_status,
  seen_at,
  created_by,
  created_at,
  queued_at,
  camp_day_id,
  printed_at,
  seen_by,
  phone_normalized,
  full_name_normalized,
  checked_in_by
) on table public.patients to authenticated;

-- Keep the existing admin-delete path; RLS and disabled-aware is_admin()
-- remain the authorization boundary.
grant delete on table public.patients to authenticated;

-- Contract the legacy non-idempotent registration/claim surface only after
-- the matching app deployment. The expand migration's idempotent RPC remains
-- the sole supported registration mutation.
drop function if exists public.register_patient(
  uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid
);
drop function if exists public.register_patient_authorized_impl(
  uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid
);

drop index if exists public.patients_account_claim_token_idx;
drop index if exists public.patients_camp_phone_unique_idx;
drop index if exists public.patients_camp_name_age_unique_idx;
drop index if exists public.patients_camp_aadhaar_name_unique_idx;

alter table public.patients
  drop column if exists account_claim_token,
  drop column if exists account_claim_expires_at;
create or replace function public.change_camp_day(
  p_patient_id uuid,
  p_new_day_id uuid
)
returns table (
  id uuid,
  reg_no integer,
  full_name text,
  camp_day_id uuid,
  day_date date
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  r public.patients%rowtype;
  v_new public.camp_days%rowtype;
  v_taken integer;
  v_camp_active boolean;
begin
  select *
  into r
  from public.patients p
  where p.id = p_patient_id
  for update;

  if r.id is null then
    raise exception 'Patient not found';
  end if;

  select c.is_active
  into v_camp_active
  from public.camps c
  where c.id = r.camp_id
  for share;

  if v_camp_active is distinct from true then
    raise exception 'Camp is no longer active';
  end if;

  if r.queue_status in ('waiting', 'seen') then
    raise exception 'Cannot change camp day after joining the queue';
  end if;

  if not public.is_staff() then
    if (select auth.uid()) is null
      or r.user_id is distinct from (select auth.uid())
    then
      raise exception 'Not allowed';
    end if;
  end if;

  select *
  into v_new
  from public.camp_days d
  where d.id = p_new_day_id
  for update;

  if v_new.id is null then
    raise exception 'Day not found';
  end if;
  if v_new.camp_id is distinct from r.camp_id then
    raise exception 'Day does not belong to this camp';
  end if;

  if r.camp_day_id is not distinct from p_new_day_id then
    return query
    select r.id, r.reg_no, r.full_name, r.camp_day_id, v_new.day_date;
    return;
  end if;

  select count(*)::integer
  into v_taken
  from public.patients p
  where p.camp_day_id = p_new_day_id;

  if v_taken >= v_new.seat_limit then
    raise exception 'That day is full (% seats taken)', v_taken;
  end if;

  update public.patients p
  set camp_day_id = p_new_day_id
  where p.id = r.id
  returning p.* into r;

  return query
  select r.id, r.reg_no, r.full_name, r.camp_day_id, v_new.day_date;
end;
$$;

revoke execute on function public.change_camp_day(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.change_camp_day(uuid, uuid)
  to authenticated, service_role;

-- Remove the pre-doctor-workflow overload retained by some fresh installs.
-- The three-argument function below is the only supported assignment API.
drop function if exists public.assign_patient_doctor(uuid, uuid);
drop function if exists public.checkin_patient_queue(uuid, integer);

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
set search_path = pg_catalog, public
as $$
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

  if r.queue_status is null
    or r.queue_status not in ('registered', 'waiting')
  then
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

  update public.patients p
  set queue_status = 'seen',
      seen_at = now(),
      seen_by = v_doctor_id,
      checked_in_by = coalesce(p.checked_in_by, (select auth.uid()))
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

revoke execute on function public.assign_patient_doctor(uuid, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.assign_patient_doctor(uuid, integer, uuid)
  to authenticated, service_role;

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
set search_path = pg_catalog, public
as $$
declare
  r public.patients%rowtype;
  v_already boolean;
begin
  if not public.is_staff() then
    raise exception 'staff only';
  end if;

  select *
  into r
  from public.patients p
  where p.id = p_id
  for update;

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

  v_already := r.printed_at is not null;

  -- A completed consultation may be printed, but it must never acquire a
  -- fabricated queue timestamp after the fact.
  if r.queue_status = 'seen' then
    if r.printed_at is null then
      update public.patients p
      set printed_at = now()
      where p.id = r.id
      returning p.* into r;
    end if;

    return query
    select r.id, r.reg_no, r.full_name, r.queue_status, v_already;
    return;
  end if;

  if r.queue_status = 'waiting' then
    if r.printed_at is null or r.queued_at is null or r.checked_in_by is null then
      update public.patients p
      set printed_at = coalesce(p.printed_at, now()),
          queued_at = coalesce(p.queued_at, now()),
          checked_in_by = coalesce(p.checked_in_by, (select auth.uid()))
      where p.id = r.id
      returning p.* into r;
    end if;

    return query
    select r.id, r.reg_no, r.full_name, r.queue_status, v_already;
    return;
  end if;

  if r.queue_status is distinct from 'registered' then
    raise exception 'Unsupported patient queue status';
  end if;

  update public.patients p
  set queue_status = 'waiting',
      queued_at = coalesce(p.queued_at, now()),
      printed_at = coalesce(p.printed_at, now()),
      checked_in_by = coalesce(p.checked_in_by, (select auth.uid()))
  where p.id = r.id
  returning p.* into r;

  return query
  select r.id, r.reg_no, r.full_name, r.queue_status, false;
end;
$$;

revoke execute on function public.mark_patient_printed(uuid)
  from public, anon, authenticated;
grant execute on function public.mark_patient_printed(uuid)
  to authenticated, service_role;

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
set search_path = pg_catalog, public
as $$
declare
  r public.patients%rowtype;
  v_caller_role public.user_role;
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
    select * into r
    from public.patients p
    where p.id = p_patient_id;
  elsif p_reg_no is not null then
    select * into r
    from public.patients p
    where p.reg_no = p_reg_no;
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

  if r.seen_by is not null then
    select p.full_name
    into v_doctor_name
    from public.profiles p
    where p.id = r.seen_by;
  end if;

  return query
  select
    r.id,
    r.reg_no,
    r.full_name,
    r.queue_status,
    case when v_caller_role = 'doctor' then null::text else r.phone end,
    r.seen_by,
    v_doctor_name;
end;
$$;

revoke execute on function public.lookup_patient_scan(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.lookup_patient_scan(uuid, integer)
  to authenticated, service_role;

create or replace function public.doctor_my_counts(
  p_camp_id uuid,
  p_since timestamptz
)
returns table (
  seen_today bigint,
  seen_total bigint
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    count(*) filter (where p.seen_at >= p_since)::bigint,
    count(*)::bigint
  from public.patients p
  where p.camp_id = p_camp_id
    and p.seen_by = (select auth.uid())
    and p.queue_status = 'seen'
    and exists (
      select 1
      from public.profiles pr
      where pr.id = (select auth.uid())
        and pr.role in ('doctor', 'admin')
        and pr.disabled_at is null
    );
$$;

revoke execute on function public.doctor_my_counts(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.doctor_my_counts(uuid, timestamptz)
  to authenticated, service_role;

-- Doctors need a recent safe worklist, not direct access to patient contact,
-- address, email, or Aadhaar columns.
create or replace function public.doctor_recent_patients(
  p_camp_id uuid,
  p_limit integer default 50
)
returns table (
  id uuid,
  reg_no integer,
  full_name text,
  seen_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.is_doctor() then raise exception 'doctor only'; end if;

  return query
  select p.id, p.reg_no, p.full_name, p.seen_at
  from public.patients p
  where p.camp_id = p_camp_id
    and p.seen_by = (select auth.uid())
    and p.queue_status = 'seen'
  order by p.seen_at desc nulls last
  limit least(greatest(coalesce(p_limit, 50), 1), 100);
end;
$$;

revoke execute on function public.doctor_recent_patients(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.doctor_recent_patients(uuid, integer)
  to authenticated, service_role;

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
set search_path = pg_catalog, public
as $$
  select
    count(*)::bigint,
    count(*) filter (
      where (p.created_by = (select auth.uid()) and p.created_at >= p_since)
        or (
          p.checked_in_by = (select auth.uid())
          and coalesce(p.queued_at, p.seen_at, p.created_at) >= p_since
        )
    )::bigint,
    count(*) filter (where p.queue_status = 'waiting')::bigint,
    count(*) filter (where p.queue_status = 'seen')::bigint
  from public.patients p
  where (p.created_by = (select auth.uid()) or p.checked_in_by = (select auth.uid()))
    and (
      not exists (select 1 from public.camps c where c.is_active)
      or p.camp_id = (
        select c.id
        from public.camps c
        where c.is_active
        limit 1
      )
    )
    and exists (
      select 1
      from public.profiles pr
      where pr.id = (select auth.uid())
        and pr.role in ('admin', 'volunteer')
        and pr.disabled_at is null
    );
$$;

revoke execute on function public.volunteer_my_counts(timestamptz)
  from public, anon, authenticated;
grant execute on function public.volunteer_my_counts(timestamptz)
  to authenticated, service_role;

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
set search_path = pg_catalog, public
as $$
declare
  v_caller_id uuid := auth.uid();
  v_caller_role public.user_role;
  v_since timestamptz := coalesce(
    p_since,
    date_trunc('day', now() at time zone 'Asia/Kolkata')
      at time zone 'Asia/Kolkata'
  );
begin
  if v_caller_id is null then
    raise exception 'not authenticated';
  end if;

  select p.role
  into v_caller_role
  from public.profiles p
  where p.id = v_caller_id
    and p.role in ('admin', 'volunteer', 'doctor')
    and p.disabled_at is null;

  if v_caller_role is null then
    raise exception 'active staff only';
  end if;

  if v_caller_role <> 'admin' then
    if v_caller_id is distinct from p_user_id
      or v_caller_role::text is distinct from p_role
    then
      raise exception 'forbidden';
    end if;
  end if;

  if p_role = 'doctor' then
    return query
    select
      count(*)::bigint,
      count(*) filter (where p.seen_at >= v_since)::bigint,
      0::bigint,
      count(*)::bigint,
      'Patients seen'::text
    from public.patients p
    where p.seen_by = p_user_id
      and p.queue_status = 'seen'
      and (p_camp_id is null or p.camp_id = p_camp_id);
  elsif p_role = 'volunteer' then
    return query
    select
      count(*)::bigint,
      count(*) filter (
        where (p.created_by = p_user_id and p.created_at >= v_since)
          or (
            p.checked_in_by = p_user_id
            and coalesce(p.queued_at, p.seen_at, p.created_at) >= v_since
          )
      )::bigint,
      count(*) filter (where p.queue_status = 'waiting')::bigint,
      count(*) filter (where p.queue_status = 'seen')::bigint,
      'Patients handled'::text
    from public.patients p
    where (p.created_by = p_user_id or p.checked_in_by = p_user_id)
      and (p_camp_id is null or p.camp_id = p_camp_id);
  else
    raise exception 'invalid role';
  end if;
end;
$$;

revoke execute on function public.staff_person_kpis(
  uuid, text, uuid, timestamptz
) from public, anon, authenticated;
grant execute on function public.staff_person_kpis(
  uuid, text, uuid, timestamptz
) to authenticated, service_role;

-- Superseded mutators have no callers; retaining privileged dead paths only
-- expands the state-transition surface.
drop function if exists public.join_queue(uuid, integer);
drop function if exists public.mark_patient_seen(uuid);

-- Remove the unused Aadhaar-verification prototype. Phone OTP is the sole
-- public registration identity path; Aadhaar lookup remains optional auto-fill.
do $$
begin
  if to_regclass('cron.job') is not null then
    execute $cron$
      select cron.unschedule(jobid)
      from cron.job
      where jobname = 'cleanup-registration-verifications'
    $cron$;
  end if;
end;
$$;

drop function if exists public.register_verified_patient(
  text, uuid, text, text, integer, text, text, text, uuid
);
drop table if exists public.registration_verifications;

-- New objects must be private until a migration grants the minimum API
-- privileges explicitly. Supabase's permissive defaults are unsafe for
-- credentials and SECURITY DEFINER functions.
alter default privileges for role postgres in schema public
  revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on functions from public, anon, authenticated;
alter default privileges for role postgres
  revoke execute on functions from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    if current_user = 'supabase_admin'
      or pg_has_role(current_user, 'supabase_admin', 'MEMBER')
    then
      execute 'alter default privileges for role supabase_admin in schema public revoke all on tables from public, anon, authenticated';
      execute 'alter default privileges for role supabase_admin in schema public revoke all on sequences from public, anon, authenticated';
      execute 'alter default privileges for role supabase_admin in schema public revoke all on functions from public, anon, authenticated';
      execute 'alter default privileges for role supabase_admin revoke execute on functions from public';
    end if;
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
