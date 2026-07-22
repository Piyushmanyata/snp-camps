-- Expand-only registration release step.
-- Apply after 20260722000000_disabled_staff_expand.sql and before deploying
-- the app that calls register_patient_idempotent(). The legacy registration
-- function and claim columns remain available until the enforce migration, so
-- the currently deployed app continues to work during rollout.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

select pg_advisory_xact_lock(
  hashtext('snp-camps:20260722005000_registration_idempotency_expand')
);

alter table public.patients
  add column if not exists registration_request_id uuid,
  add column if not exists account_provisioning_token text;

comment on column public.patients.registration_request_id is
  'Opaque per-submission idempotency key; server-internal and never exposed through table grants.';
comment on column public.patients.account_provisioning_token is
  'Transient server-only compare-and-set token for admin login provisioning.';

create unique index if not exists patients_registration_request_id_idx
  on public.patients (registration_request_id)
  where registration_request_id is not null;

create unique index if not exists patients_account_provisioning_token_idx
  on public.patients (account_provisioning_token)
  where account_provisioning_token is not null;

create or replace function public.register_patient_idempotent(
  p_request_id uuid,
  p_camp_id uuid,
  p_full_name text,
  p_gender text default null,
  p_age integer default null,
  p_address text default null,
  p_phone text default null,
  p_email text default null,
  p_aadhaar_last4 text default null,
  p_user_id uuid default null,
  p_created_by uuid default null,
  p_camp_day_id uuid default null
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
  v_request_role text;
  v_user_id uuid;
  v_created_by uuid;
  v_aadhaar char(4);
  v_name text;
  v_phone10 text;
  v_existing_reg integer;
  v_day public.camp_days%rowtype;
  v_taken integer;
  v_row public.patients%rowtype;
begin
  if p_request_id is null then
    raise exception 'registration request id required';
  end if;

  v_request_role := coalesce(
    nullif(auth.role(), ''),
    nullif(current_setting('request.jwt.claim.role', true), '')
  );

  if v_request_role = 'service_role' then
    v_user_id := p_user_id;
    v_created_by := case when p_user_id is null then p_created_by else null end;
  elsif v_request_role = 'authenticated' then
    if not exists (
      select 1
      from public.profiles p
      where p.id = (select auth.uid())
        and p.role in ('admin', 'volunteer')
        and p.disabled_at is null
    ) then
      raise exception 'active admin or volunteer required';
    end if;
    -- Desk callers cannot bind registrations to arbitrary accounts or forge
    -- their audit owner.
    v_user_id := null;
    v_created_by := (select auth.uid());
  else
    raise exception 'authenticated registration required';
  end if;

  -- Serialize every retry before looking up the first committed result. This
  -- makes a lost-response retry return the original row without consuming a
  -- second seat, including concurrent retries.
  perform pg_advisory_xact_lock(
    hashtext('register-request:' || p_request_id::text)
  );

  select p.id, p.reg_no, p.full_name, p.camp_day_id, d.day_date
  into id, reg_no, full_name, camp_day_id, day_date
  from public.patients p
  join public.camp_days d on d.id = p.camp_day_id
  where p.registration_request_id = p_request_id;

  if found then
    return next;
    return;
  end if;

  v_name := trim(coalesce(p_full_name, ''));
  if length(v_name) = 0 or length(v_name) > 120 then
    raise exception 'full_name required and must be at most 120 characters';
  end if;
  if p_age is not null and (p_age < 0 or p_age >= 150) then
    raise exception 'age must be between 0 and 149';
  end if;

  if not exists (
    select 1
    from public.camps c
    where c.id = p_camp_id and c.is_active
  ) then
    raise exception 'No active camp';
  end if;

  if p_camp_day_id is null then
    raise exception 'Please select a camp day';
  end if;

  if v_user_id is not null then
    -- A separate request id from another tab must not race the reliable
    -- one-user-per-camp constraint.
    perform pg_advisory_xact_lock(
      hashtext('register-user:' || p_camp_id::text || ':' || v_user_id::text)
    );

    select p.reg_no
    into v_existing_reg
    from public.patients p
    where p.camp_id = p_camp_id
      and p.user_id = v_user_id
    limit 1;

    if v_existing_reg is not null then
      raise exception
        'Already registered for this camp (reg no %). Change day instead.',
        v_existing_reg;
    end if;
  end if;

  select *
  into v_day
  from public.camp_days d
  where d.id = p_camp_day_id
  for update;

  if v_day.id is null or v_day.camp_id is distinct from p_camp_id then
    raise exception 'Invalid camp day';
  end if;

  select count(*)::integer
  into v_taken
  from public.patients p
  where p.camp_day_id = p_camp_day_id;

  if v_taken >= v_day.seat_limit then
    raise exception 'This day is full (% seats). Choose another day.', v_day.seat_limit;
  end if;

  if p_aadhaar_last4 is null or length(trim(p_aadhaar_last4)) = 0 then
    v_aadhaar := null;
  else
    v_aadhaar := right(regexp_replace(p_aadhaar_last4, '\D', '', 'g'), 4);
    if v_aadhaar !~ '^[0-9]{4}$' then
      raise exception 'Invalid aadhaar last4';
    end if;
  end if;

  v_phone10 := nullif(
    right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10),
    ''
  );
  if v_phone10 is not null and length(v_phone10) < 10 then
    v_phone10 := null;
  end if;

  insert into public.patients (
    registration_request_id,
    camp_id,
    camp_day_id,
    user_id,
    full_name,
    gender,
    age,
    address,
    phone,
    email,
    aadhaar_last4,
    created_by,
    queue_status,
    queued_at
  )
  values (
    p_request_id,
    p_camp_id,
    p_camp_day_id,
    v_user_id,
    v_name,
    case when p_gender in ('M', 'F', 'O') then p_gender else null end,
    p_age,
    nullif(trim(coalesce(p_address, '')), ''),
    v_phone10,
    nullif(trim(coalesce(p_email, '')), ''),
    v_aadhaar,
    v_created_by,
    'registered',
    null
  )
  returning public.patients.* into v_row;

  id := v_row.id;
  reg_no := v_row.reg_no;
  full_name := v_row.full_name;
  camp_day_id := v_row.camp_day_id;
  day_date := v_day.day_date;
  return next;
end;
$$;

revoke all on function public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid
) from public, anon;
grant execute on function public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid
) to authenticated, service_role;

-- Predeploy compatibility: the matching doctor page uses this privacy-safe
-- worklist before the broader enforce migration is applied.
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
  if not exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'doctor'
      and p.disabled_at is null
  ) then
    raise exception 'doctor only';
  end if;

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

revoke all on function public.doctor_recent_patients(uuid, integer)
  from public, anon;
grant execute on function public.doctor_recent_patients(uuid, integer)
  to authenticated, service_role;

-- Readiness checks this live contract instead of assuming that one successful
-- table query proves every app/database interface was deployed together.
create or replace function public.app_database_contract()
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select case
    when to_regprocedure(
      'public.register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid)'
    ) is not null
      and to_regprocedure('public.doctor_recent_patients(uuid,integer)') is not null
      and to_regprocedure('public.link_patient_phone(text)') is not null
      and exists (
        select 1
        from pg_catalog.pg_attribute a
        join pg_catalog.pg_class c on c.oid = a.attrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname = 'patients'
          and a.attname = 'registration_request_id'
          and a.attnum > 0
          and not a.attisdropped
      )
      and exists (
        select 1
        from pg_catalog.pg_attribute a
        join pg_catalog.pg_class c on c.oid = a.attrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname = 'patients'
          and a.attname = 'account_provisioning_token'
          and a.attnum > 0
          and not a.attisdropped
      )
    then '20260722005000'
    else 'incomplete'
  end;
$$;

revoke all on function public.app_database_contract()
  from public, anon, authenticated;
grant execute on function public.app_database_contract() to service_role;

notify pgrst, 'reload schema';

commit;
