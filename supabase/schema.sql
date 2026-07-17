-- SNP Camps v1 — run once in Supabase SQL Editor
create extension if not exists "pgcrypto";

create type public.user_role as enum ('admin', 'volunteer', 'patient');
create type public.queue_status as enum ('waiting', 'seen');

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
  queue_status public.queue_status not null default 'waiting',
  seen_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (reg_no)
);

create index patients_camp_queue_idx on public.patients (camp_id, queue_status, created_at);
create index patients_phone_idx on public.patients (phone);
create index patients_name_idx on public.patients (full_name);

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
    where id = auth.uid() and role in ('admin', 'volunteer')
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
  for update using (id = auth.uid() or public.is_admin());
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
create policy "staff all patients" on public.patients
  for all using (public.is_staff())
  with check (public.is_staff());
create policy "patient read own" on public.patients
  for select using (user_id = auth.uid());
create policy "patient update own link" on public.patients
  for update using (user_id = auth.uid());
-- desk / self-reg on active camp (authenticated or anon walk-up kiosk)
create policy "register on active camp" on public.patients
  for insert
  with check (
    exists (
      select 1 from public.camps c
      where c.id = camp_id and c.is_active = true
    )
    and (
      public.is_staff()
      or user_id is null
      or user_id = auth.uid()
    )
  );

grant usage on sequence public.patient_reg_no_seq to authenticated, anon;
grant select, insert, update on public.patients to authenticated;
grant select on public.camps to anon, authenticated;
grant select, update on public.profiles to authenticated;

-- elevate role after signup if metadata staff_role is set (invite-gated in app)
create or replace function public.claim_staff_role(p_role text, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  meta_role text;
begin
  select raw_user_meta_data->>'staff_role' into meta_role
  from auth.users where id = auth.uid();

  if meta_role is null or meta_role not in ('admin', 'volunteer') then
    raise exception 'not allowed';
  end if;
  if p_role is distinct from meta_role then
    raise exception 'role mismatch';
  end if;

  update public.profiles
  set role = meta_role::public.user_role,
      full_name = coalesce(nullif(p_name, ''), full_name)
  where id = auth.uid();
end;
$$;

grant execute on function public.claim_staff_role(text, text) to authenticated;
grant execute on function public.set_active_camp(uuid) to authenticated;
grant execute on function public.is_staff() to authenticated;
grant execute on function public.is_admin() to authenticated;

-- mark seen on print (staff only)
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
      seen_at = coalesce(seen_at, now())
  where id = p_id;
end;
$$;

grant execute on function public.mark_patient_seen(uuid) to authenticated;
