-- Security and integrity hardening for the v3 camp flow.
-- Apply after fix-ambiguous-and-delete-camp.sql and fix-doctor-scan-no-print.sql.

-- Anonymous callers only need the registration RPC; they must not be able to
-- read unlinked patient rows (which contain PII).
revoke select on table public.patients from anon;
drop policy if exists "read unlinked on active camp" on public.patients;
drop function if exists public.claim_staff_role(text, text);
revoke all on function public.is_staff() from public;
revoke all on function public.is_admin() from public;
revoke all on function public.is_doctor() from public;
grant execute on function public.is_staff() to anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.is_doctor() to authenticated;

-- A short-lived, single-use claim is returned only for self-registration.
-- It lets the public registration page finish account creation without making
-- patient UUID + registration number sufficient to take over an account.
alter table public.patients
  add column if not exists account_claim_token text;

alter table public.patients
  add column if not exists account_claim_expires_at timestamptz;

-- Persist canonical lookup keys so duplicate checks use indexes instead of
-- running regexp/lower expressions across every registration while holding a
-- capacity lock.
alter table public.patients
  add column if not exists phone_normalized text
  generated always as (
    nullif(right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10), '')
  ) stored;

alter table public.patients
  add column if not exists full_name_normalized text
  generated always as (lower(btrim(full_name))) stored;

create index if not exists patients_user_id_idx
  on public.patients (user_id)
  where user_id is not null;

create index if not exists patients_created_by_idx
  on public.patients (created_by)
  where created_by is not null;

create unique index if not exists patients_camp_user_unique_idx
  on public.patients (camp_id, user_id)
  where user_id is not null;

create unique index if not exists patients_camp_phone_unique_idx
  on public.patients (camp_id, phone_normalized)
  where phone_normalized is not null and length(phone_normalized) = 10;

create unique index if not exists patients_camp_aadhaar_name_unique_idx
  on public.patients (camp_id, aadhaar_last4, full_name_normalized)
  where aadhaar_last4 is not null;

create unique index if not exists patients_camp_name_age_unique_idx
  on public.patients (camp_id, full_name_normalized, age)
  where phone_normalized is null and aadhaar_last4 is null and age is not null;

create index if not exists patients_seen_by_camp_seen_at_idx
  on public.patients (camp_id, seen_by, seen_at desc)
  where queue_status = 'seen' and seen_by is not null;

create unique index if not exists patients_account_claim_token_idx
  on public.patients (account_claim_token)
  where account_claim_token is not null;

-- Remove legacy overloads that bypass camp-day validation.
drop function if exists public.register_patient(
  uuid, text, text, integer, text, text, text, text, uuid, uuid
);
drop function if exists public.register_patient(
  uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid
);

create function public.register_patient(
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
  day_date date,
  claim_token text
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_request_role text;
  v_user_id uuid;
  v_created_by uuid;
  v_aadhaar char(4);
  v_name text;
  v_phone text;
  v_phone10 text;
  v_existing_reg integer;
  v_day public.camp_days%rowtype;
  v_taken integer;
  v_row public.patients%rowtype;
begin
  v_request_role := nullif(current_setting('request.jwt.claim.role', true), '');
  if v_request_role = 'authenticated' and not public.is_staff() then
    raise exception 'staff only';
  end if;
  if v_request_role not in ('anon', 'authenticated', 'service_role') then
    raise exception 'API role required';
  end if;

  v_name := trim(coalesce(p_full_name, ''));
  if length(v_name) = 0 then
    raise exception 'full_name required';
  end if;

  if not exists (
    select 1 from public.camps c
    where c.id = p_camp_id and c.is_active = true
  ) then
    raise exception 'No active camp';
  end if;

  if p_camp_day_id is null then
    raise exception 'Please select a camp day';
  end if;

  select * into v_day
  from public.camp_days d
  where d.id = p_camp_day_id
  for update;

  if v_day.id is null or v_day.camp_id is distinct from p_camp_id then
    raise exception 'Invalid camp day';
  end if;

  select count(*)::int into v_taken
  from public.patients p
  where p.camp_day_id = p_camp_day_id;
  if v_taken >= v_day.seat_limit then
    raise exception 'This day is full (% seats). Choose another day.', v_day.seat_limit;
  end if;

  if p_user_id is not null then
    if p_user_id is distinct from auth.uid() and not public.is_staff() then
      raise exception 'Cannot register for another user';
    end if;
    v_user_id := p_user_id;
  else
    v_user_id := null;
  end if;

  if public.is_staff() then
    v_created_by := coalesce(p_created_by, auth.uid());
  else
    v_created_by := auth.uid();
  end if;

  if p_aadhaar_last4 is null or length(trim(p_aadhaar_last4)) = 0 then
    v_aadhaar := null;
  else
    v_aadhaar := right(regexp_replace(p_aadhaar_last4, '\D', '', 'g'), 4);
    if v_aadhaar !~ '^[0-9]{4}$' then
      raise exception 'Invalid aadhaar last4';
    end if;
  end if;

  v_phone := nullif(trim(coalesce(p_phone, '')), '');
  v_phone10 := nullif(
    right(regexp_replace(coalesce(v_phone, ''), '\D', '', 'g'), 10),
    ''
  );
  if v_phone10 is not null and length(v_phone10) < 10 then
    v_phone10 := null;
  end if;

  if v_user_id is not null then
    select p.reg_no into v_existing_reg
    from public.patients p
    where p.camp_id = p_camp_id and p.user_id = v_user_id
    limit 1;
    if v_existing_reg is not null then
      raise exception 'Already registered for this camp (reg no %). Change day instead.', v_existing_reg;
    end if;
  end if;

  if v_phone10 is not null then
    select p.reg_no into v_existing_reg
    from public.patients p
    where p.camp_id = p_camp_id
      and p.phone_normalized = v_phone10
    limit 1;
    if v_existing_reg is not null then
      raise exception 'Already registered for this camp with this phone (reg no %). Change day instead.', v_existing_reg;
    end if;
  end if;

  if v_aadhaar is not null then
    select p.reg_no into v_existing_reg
    from public.patients p
    where p.camp_id = p_camp_id
      and p.aadhaar_last4 = v_aadhaar
      and p.full_name_normalized = lower(v_name)
    limit 1;
    if v_existing_reg is not null then
      raise exception 'Already registered for this camp (same name + Aadhaar last 4, reg no %). Change day instead.', v_existing_reg;
    end if;
  end if;

  if v_phone10 is null and v_aadhaar is null and p_age is not null then
    select p.reg_no into v_existing_reg
    from public.patients p
    where p.camp_id = p_camp_id
      and p.full_name_normalized = lower(v_name)
      and p.age = p_age
    limit 1;
    if v_existing_reg is not null then
      raise exception 'Already registered for this camp (same name + age, reg no %). Change day instead.', v_existing_reg;
    end if;
  end if;

  insert into public.patients (
    camp_id, camp_day_id, user_id, full_name, gender, age, address, phone, email,
    aadhaar_last4, created_by, queue_status, queued_at, account_claim_token,
    account_claim_expires_at
  ) values (
    p_camp_id,
    p_camp_day_id,
    v_user_id,
    v_name,
    case when p_gender in ('M','F','O') then p_gender else null end,
    p_age,
    nullif(trim(coalesce(p_address, '')), ''),
    v_phone10,
    nullif(trim(coalesce(p_email, '')), ''),
    v_aadhaar,
    v_created_by,
    'registered',
    null,
    case when public.is_staff() then null else encode(extensions.gen_random_bytes(24), 'hex') end,
    case when public.is_staff() then null else now() + interval '30 minutes' end
  )
  returning
    public.patients.id,
    public.patients.reg_no,
    public.patients.full_name,
    public.patients.camp_day_id,
    public.patients.account_claim_token
  into
    v_row.id,
    v_row.reg_no,
    v_row.full_name,
    v_row.camp_day_id,
    v_row.account_claim_token;

  id := v_row.id;
  reg_no := v_row.reg_no;
  full_name := v_row.full_name;
  camp_day_id := v_row.camp_day_id;
  day_date := v_day.day_date;
  claim_token := v_row.account_claim_token;
  return next;
end;
$$;

revoke all on function public.register_patient(
  uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.register_patient(
  uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid
) to anon, authenticated;

-- Serialize scan decisions and allow only actual doctor profiles as assignees.
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
    select * into r
    from public.patients
    where patients.id = p_patient_id
    for update;
  elsif p_reg_no is not null then
    select * into r
    from public.patients
    where patients.reg_no = p_reg_no
    for update;
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

  if r.queue_status = 'seen' then
    select pr.full_name into v_doctor_name
    from public.profiles pr
    where pr.id = r.seen_by;
    return query
    select r.id, r.reg_no, r.full_name, r.queue_status, r.seen_by,
      coalesce(v_doctor_name, 'Unknown'), true, 'already_seen'::text;
    return;
  end if;

  if v_caller_role = 'doctor' then
    v_doctor_id := auth.uid();
  elsif p_doctor_id is not null then
    v_doctor_id := p_doctor_id;
  else
    return query
    select r.id, r.reg_no, r.full_name, r.queue_status,
      null::uuid, null::text, false, 'doctor_required'::text;
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
      queued_at = coalesce(queued_at, now())
  where patients.id = r.id;

  return query
  select r.id, r.reg_no, r.full_name, 'seen'::public.queue_status,
    v_doctor_id, coalesce(v_doctor_name, 'Doctor'), false, null::text;
end;
$$;

revoke all on function public.assign_patient_doctor(uuid, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.assign_patient_doctor(uuid, integer, uuid)
  to authenticated;

-- Recreate every queue RPC with the same active-camp and row-lock invariants.
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
  if not public.is_staff() then raise exception 'staff only'; end if;
  select * into r from public.patients where patients.id = p_id for update;
  if r.id is null then raise exception 'Patient not found'; end if;
  if not exists (select 1 from public.camps c where c.id = r.camp_id and c.is_active) then
    raise exception 'Patient belongs to an inactive camp';
  end if;

  if r.queue_status in ('waiting', 'seen') then
    v_already := true;
    if r.printed_at is null or r.queued_at is null then
      update public.patients
      set printed_at = coalesce(printed_at, now()), queued_at = coalesce(queued_at, now())
      where patients.id = r.id
      returning * into r;
    end if;
    return query select r.id, r.reg_no, r.full_name, r.queue_status, v_already;
    return;
  end if;

  update public.patients
  set queue_status = 'waiting', queued_at = coalesce(queued_at, now()), printed_at = coalesce(printed_at, now())
  where patients.id = r.id
  returning * into r;
  return query select r.id, r.reg_no, r.full_name, r.queue_status, false;
end;
$$;

revoke all on function public.mark_patient_printed(uuid) from public;
grant execute on function public.mark_patient_printed(uuid) to authenticated;

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
  if not public.is_staff() then raise exception 'staff only'; end if;
  if p_patient_id is not null then
    select * into r from public.patients where patients.id = p_patient_id for update;
  elsif p_reg_no is not null then
    select * into r from public.patients where patients.reg_no = p_reg_no for update;
  else
    raise exception 'Provide patient id or reg no';
  end if;
  if r.id is null then raise exception 'Patient not found'; end if;
  if not exists (select 1 from public.camps c where c.id = r.camp_id and c.is_active) then
    raise exception 'Patient belongs to an inactive camp';
  end if;
  if r.queue_status = 'seen' then
    return query select r.id, r.reg_no, r.full_name, r.queue_status, true;
    return;
  end if;
  if r.queue_status = 'waiting' then
    v_already := true;
    if r.printed_at is null or r.queued_at is null then
      update public.patients
      set printed_at = coalesce(printed_at, now()), queued_at = coalesce(queued_at, now())
      where patients.id = r.id
      returning * into r;
    end if;
  else
    update public.patients
    set queue_status = 'waiting', queued_at = coalesce(queued_at, now()), printed_at = coalesce(printed_at, now())
    where patients.id = r.id
    returning * into r;
  end if;
  return query select r.id, r.reg_no, r.full_name, r.queue_status, v_already;
end;
$$;

revoke all on function public.join_queue(uuid, integer) from public;
grant execute on function public.join_queue(uuid, integer) to authenticated;

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
  if not public.is_staff() then raise exception 'staff only'; end if;
  if p_patient_id is not null then
    select * into r from public.patients where patients.id = p_patient_id;
  elsif p_reg_no is not null then
    select * into r from public.patients where patients.reg_no = p_reg_no;
  else
    raise exception 'Provide patient id or reg no';
  end if;
  if r.id is null then raise exception 'Patient not found'; end if;
  if not exists (select 1 from public.camps c where c.id = r.camp_id and c.is_active) then
    raise exception 'Patient belongs to an inactive camp';
  end if;
  if r.seen_by is not null then
    select pr.full_name into v_doctor_name from public.profiles pr where pr.id = r.seen_by;
  end if;
  return query select r.id, r.reg_no, r.full_name, r.queue_status, r.phone, r.seen_by, v_doctor_name;
end;
$$;

revoke all on function public.lookup_patient_scan(uuid, integer) from public;
grant execute on function public.lookup_patient_scan(uuid, integer) to authenticated;

create or replace function public.mark_patient_seen(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_doctor() then
    perform public.assign_patient_doctor(p_id, null, auth.uid());
    return;
  end if;
  raise exception 'Use assign doctor (scan). Print only puts patient in queue.';
end;
$$;

revoke all on function public.mark_patient_seen(uuid) from public;
grant execute on function public.mark_patient_seen(uuid) to authenticated;

-- Patients must never receive direct UPDATE on queue or identity linkage.
revoke insert, update on table public.patients from anon, authenticated;
drop policy if exists "staff insert patients" on public.patients;
drop policy if exists "staff update patients" on public.patients;
drop policy if exists "patient update own link" on public.patients;
drop policy if exists "register on active camp" on public.patients;

drop policy if exists "update own profile" on public.profiles;
drop policy if exists "update own patient profile" on public.profiles;
create policy "update own patient profile" on public.profiles
  for update
  using (id = auth.uid() or public.is_admin())
  with check (public.is_admin() or (id = auth.uid() and role = 'patient'));

create or replace function public.link_patient_phone(p_phone text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone10 text;
  v_count integer;
  v_patient_id uuid;
  v_auth_phone10 text;
  v_phone_confirmed_at timestamptz;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  v_phone10 := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10);
  if length(v_phone10) <> 10 then raise exception 'Valid phone required'; end if;

  select u.phone, u.phone_confirmed_at
  into v_auth_phone10, v_phone_confirmed_at
  from auth.users u
  where u.id = auth.uid();

  if
    v_phone_confirmed_at is null
    or v_auth_phone10 is distinct from '+91' || v_phone10
  then
    raise exception 'Use the phone number verified for this account';
  end if;

  select count(*)::int, min(p.id) into v_count, v_patient_id
  from public.patients p
  join public.camps c on c.id = p.camp_id and c.is_active
  where p.user_id is null
    and p.phone_normalized = v_phone10;
  if v_count = 0 then raise exception 'No unlinked registration was found for this phone number'; end if;
  if v_count > 1 then raise exception 'Multiple registrations found; ask the desk to link your account'; end if;
  update public.patients set user_id = auth.uid() where id = v_patient_id and user_id is null;
  if not found then raise exception 'Registration was already linked'; end if;
  return v_patient_id;
end;
$$;

revoke all on function public.link_patient_phone(text) from public;
grant execute on function public.link_patient_phone(text) to authenticated;
