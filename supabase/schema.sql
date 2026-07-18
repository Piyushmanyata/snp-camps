-- SNP Camps v1 — run once in Supabase SQL Editor
create extension if not exists pgcrypto with schema extensions;

create type public.user_role as enum ('admin', 'volunteer', 'doctor', 'patient');
create type public.queue_status as enum ('registered', 'waiting', 'seen');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role public.user_role not null default 'patient',
  full_name text,
  phone text,
  email text,
  created_at timestamptz not null default now()
);

create table public.camps (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  venue text,
  camp_date date,
  is_active boolean not null default false,
  created_at timestamptz not null default now()
);

-- only one active camp
create unique index camps_one_active on public.camps (is_active) where is_active = true;

create sequence public.patient_reg_no_seq start 1000;

create table public.patients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  camp_id uuid not null references public.camps (id) on delete restrict,
  reg_no integer not null default nextval('public.patient_reg_no_seq'),
  full_name text not null,
  gender text check (gender in ('M', 'F', 'O') or gender is null),
  age integer check (age is null or (age >= 0 and age < 150)),
  address text,
  phone text,
  email text,
  aadhaar_last4 char(4) check (aadhaar_last4 is null or aadhaar_last4 ~ '^[0-9]{4}$'),
  queue_status public.queue_status not null default 'registered',
  queued_at timestamptz,
  printed_at timestamptz,
  seen_at timestamptz,
  seen_by uuid references public.profiles (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null,
  account_claim_token text,
  account_claim_expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (reg_no)
);

create index patients_camp_queue_idx on public.patients (camp_id, queue_status, created_at);
create index patients_phone_idx on public.patients (phone);
create index patients_name_idx on public.patients (full_name);
create unique index patients_account_claim_token_idx
  on public.patients (account_claim_token)
  where account_claim_token is not null;
create index patients_seen_by_camp_seen_at_idx
  on public.patients (camp_id, seen_by, seen_at desc)
  where queue_status = 'seen' and seen_by is not null;

-- auto profile on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, role, full_name, phone, email)
  values (
    new.id,
    'patient',
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    coalesce(new.phone, new.raw_user_meta_data->>'phone', null),
    new.email
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

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

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.set_active_camp(p_camp_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'admin only';
  end if;
  update public.camps set is_active = false where is_active = true;
  update public.camps set is_active = true where id = p_camp_id;
end;
$$;

alter table public.profiles enable row level security;
alter table public.camps enable row level security;
alter table public.patients enable row level security;

-- profiles
create policy "read own profile" on public.profiles
  for select using (id = auth.uid() or public.is_staff());
create policy "update own profile" on public.profiles
  for update using (id = auth.uid() or public.is_admin())
  with check (public.is_admin() or (id = auth.uid() and role = 'patient'));
create policy "admin update any profile" on public.profiles
  for all using (public.is_admin());

-- camps: everyone authenticated can read; admin write
create policy "read camps" on public.camps
  for select to authenticated using (true);
create policy "public read active camp" on public.camps
  for select to anon using (is_active = true);
create policy "admin camps" on public.camps
  for all using (public.is_admin());

-- patients
create policy "staff select patients" on public.patients
  for select using (public.is_staff());
create policy "admin delete patients" on public.patients
  for delete using (public.is_admin());
create policy "patient read own" on public.patients
  for select to authenticated using (user_id = auth.uid());
grant select, delete on public.patients to authenticated;
revoke insert, update on public.patients from anon, authenticated;
grant select on public.camps to anon, authenticated;
grant select, update on public.profiles to authenticated;
grant execute on function public.is_staff() to anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;
revoke all on function public.is_staff() from public;
revoke all on function public.is_admin() from public;

-- Prevent the same patient registering twice on the same camp.
-- Match keys (in order): phone (last 10 digits), aadhaar last4 + name, linked user_id,
-- fallback name + age when no phone/aadhaar.

create or replace function public.register_patient(
  p_camp_id uuid,
  p_full_name text,
  p_gender text default null,
  p_age integer default null,
  p_address text default null,
  p_phone text default null,
  p_email text default null,
  p_aadhaar_last4 text default null,
  p_user_id uuid default null,
  p_created_by uuid default null
)
returns table (id uuid, reg_no integer, full_name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_created_by uuid;
  v_aadhaar char(4);
  v_name text;
  v_phone text;
  v_phone10 text;
  v_existing_reg integer;
begin
  v_name := trim(coalesce(p_full_name, ''));
  if length(v_name) = 0 then
    raise exception 'full_name required';
  end if;

  if not exists (select 1 from public.camps c where c.id = p_camp_id and c.is_active = true) then
    raise exception 'No active camp';
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
  v_phone10 := nullif(right(regexp_replace(coalesce(v_phone, ''), '\D', '', 'g'), 10), '');
  if v_phone10 is not null and length(v_phone10) < 10 then
    v_phone10 := null;
  end if;

  -- 1) Same linked user already on this camp
  if v_user_id is not null then
    select p.reg_no into v_existing_reg
    from public.patients p
    where p.camp_id = p_camp_id and p.user_id = v_user_id
    limit 1;
    if v_existing_reg is not null then
      raise exception 'Already registered for this camp (reg no %).', v_existing_reg;
    end if;
  end if;

  -- 2) Same phone (last 10 digits) on this camp
  if v_phone10 is not null then
    select p.reg_no into v_existing_reg
    from public.patients p
    where p.camp_id = p_camp_id
      and right(regexp_replace(coalesce(p.phone, ''), '\D', '', 'g'), 10) = v_phone10
    limit 1;
    if v_existing_reg is not null then
      raise exception 'Already registered for this camp with this phone (reg no %).', v_existing_reg;
    end if;
  end if;

  -- 3) Same Aadhaar last4 + name on this camp
  if v_aadhaar is not null then
    select p.reg_no into v_existing_reg
    from public.patients p
    where p.camp_id = p_camp_id
      and p.aadhaar_last4 = v_aadhaar
      and lower(trim(p.full_name)) = lower(v_name)
    limit 1;
    if v_existing_reg is not null then
      raise exception 'Already registered for this camp (same name + Aadhaar last 4, reg no %).', v_existing_reg;
    end if;
  end if;

  -- 4) Fallback when no phone/aadhaar: same name + age on this camp
  if v_phone10 is null and v_aadhaar is null and p_age is not null then
    select p.reg_no into v_existing_reg
    from public.patients p
    where p.camp_id = p_camp_id
      and lower(trim(p.full_name)) = lower(v_name)
      and p.age = p_age
    limit 1;
    if v_existing_reg is not null then
      raise exception 'Already registered for this camp (same name + age, reg no %).', v_existing_reg;
    end if;
  end if;

  return query
  insert into public.patients (
    camp_id, user_id, full_name, gender, age, address, phone, email, aadhaar_last4, created_by, queue_status, queued_at
  ) values (
    p_camp_id,
    v_user_id,
    v_name,
    case when p_gender in ('M','F','O') then p_gender else null end,
    p_age,
    nullif(trim(coalesce(p_address, '')), ''),
    v_phone,
    nullif(trim(coalesce(p_email, '')), ''),
    v_aadhaar,
    v_created_by,
    'registered',
    null
  )
  returning patients.id, patients.reg_no, patients.full_name;
end;
$$;

grant execute on function public.register_patient(
  uuid, text, text, integer, text, text, text, text, uuid, uuid
) to anon, authenticated;

grant execute on function public.set_active_camp(uuid) to authenticated;
grant execute on function public.is_staff() to authenticated;
grant execute on function public.is_admin() to authenticated;


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

-- mark seen on print (staff only). Ensures queued_at if they never checked in.
create or replace function public.mark_patient_seen(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_staff() then
    raise exception 'staff only';
  end if;
  update public.patients
  set queue_status = 'seen',
      seen_at = coalesce(seen_at, now()),
      queued_at = coalesce(queued_at, now())
  where id = p_id;
end;
$$;

grant execute on function public.mark_patient_seen(uuid) to authenticated;
