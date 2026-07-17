-- Multi-day camps with per-day seat limits

create table if not exists public.camp_days (
  id uuid primary key default gen_random_uuid(),
  camp_id uuid not null references public.camps (id) on delete cascade,
  day_date date not null,
  seat_limit integer not null check (seat_limit >= 0),
  created_at timestamptz not null default now(),
  unique (camp_id, day_date)
);

create index if not exists camp_days_camp_date_idx
  on public.camp_days (camp_id, day_date);

alter table public.patients
  add column if not exists camp_day_id uuid references public.camp_days (id) on delete restrict;

create index if not exists patients_camp_day_idx on public.patients (camp_day_id);

alter table public.camp_days enable row level security;

drop policy if exists "read camp days" on public.camp_days;
create policy "read camp days" on public.camp_days
  for select to anon, authenticated using (true);

drop policy if exists "admin camp days" on public.camp_days;
create policy "admin camp days" on public.camp_days
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant select on public.camp_days to anon, authenticated;
grant insert, update, delete on public.camp_days to authenticated;

-- Seed: for each camp without days, create one day from camp_date (or today) with 200 seats
insert into public.camp_days (camp_id, day_date, seat_limit)
select c.id, coalesce(c.camp_date, current_date), 200
from public.camps c
where not exists (select 1 from public.camp_days d where d.camp_id = c.id)
on conflict (camp_id, day_date) do nothing;

-- Assign patients missing a day to the earliest day of their camp
update public.patients p
set camp_day_id = (
  select d.id from public.camp_days d
  where d.camp_id = p.camp_id
  order by d.day_date
  limit 1
)
where p.camp_day_id is null;

-- Public/staff seat board for a camp (or active camp if null)
create or replace function public.camp_day_stats(p_camp_id uuid default null)
returns table (
  id uuid,
  camp_id uuid,
  day_date date,
  seat_limit integer,
  seats_taken integer,
  seats_left integer,
  is_full boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with target as (
    select coalesce(
      p_camp_id,
      (select c.id from public.camps c where c.is_active = true limit 1)
    ) as camp_id
  )
  select
    d.id,
    d.camp_id,
    d.day_date,
    d.seat_limit,
    count(p.id)::integer as seats_taken,
    greatest(d.seat_limit - count(p.id)::integer, 0) as seats_left,
    (count(p.id)::integer >= d.seat_limit) as is_full
  from public.camp_days d
  cross join target t
  left join public.patients p on p.camp_day_id = d.id
  where d.camp_id = t.camp_id
  group by d.id, d.camp_id, d.day_date, d.seat_limit
  order by d.day_date;
$$;

grant execute on function public.camp_day_stats(uuid) to anon, authenticated;

-- Admin upsert camp day seats
create or replace function public.upsert_camp_day(
  p_camp_id uuid,
  p_day_date date,
  p_seat_limit integer,
  p_day_id uuid default null
)
returns public.camp_days
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.camp_days;
  v_taken integer;
begin
  if not public.is_admin() then
    raise exception 'admin only';
  end if;
  if p_seat_limit is null or p_seat_limit < 0 then
    raise exception 'seat_limit must be >= 0';
  end if;

  if p_day_id is not null then
    select count(*)::int into v_taken from public.patients where camp_day_id = p_day_id;
    if p_seat_limit < v_taken then
      raise exception 'Cannot set seats below taken (%)', v_taken;
    end if;
    update public.camp_days
    set day_date = p_day_date,
        seat_limit = p_seat_limit
    where id = p_day_id and camp_id = p_camp_id
    returning * into r;
    if r.id is null then
      raise exception 'Day not found';
    end if;
    return r;
  end if;

  insert into public.camp_days (camp_id, day_date, seat_limit)
  values (p_camp_id, p_day_date, p_seat_limit)
  on conflict (camp_id, day_date)
  do update set seat_limit = excluded.seat_limit
  returning * into r;

  select count(*)::int into v_taken from public.patients where camp_day_id = r.id;
  if r.seat_limit < v_taken then
    raise exception 'Cannot set seats below taken (%)', v_taken;
  end if;

  return r;
end;
$$;

grant execute on function public.upsert_camp_day(uuid, date, integer, uuid) to authenticated;

create or replace function public.delete_camp_day(p_day_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'admin only';
  end if;
  if exists (select 1 from public.patients where camp_day_id = p_day_id) then
    raise exception 'Cannot delete a day that has patients — reassign them first';
  end if;
  delete from public.camp_days where id = p_day_id;
end;
$$;

grant execute on function public.delete_camp_day(uuid) to authenticated;

-- Change registration day (one day per patient; only if seats free)
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
set search_path = public
as $$
declare
  r public.patients%rowtype;
  v_new public.camp_days%rowtype;
  v_taken integer;
begin
  select * into r from public.patients where patients.id = p_patient_id for update;
  if r.id is null then
    raise exception 'Patient not found';
  end if;

  if r.queue_status in ('waiting', 'seen') then
    raise exception 'Cannot change camp day after joining the queue';
  end if;

  if not public.is_staff() then
    if auth.uid() is null or r.user_id is distinct from auth.uid() then
      raise exception 'Not allowed';
    end if;
  end if;

  select * into v_new from public.camp_days where camp_days.id = p_new_day_id for update;
  if v_new.id is null then
    raise exception 'Day not found';
  end if;
  if v_new.camp_id is distinct from r.camp_id then
    raise exception 'Day does not belong to this camp';
  end if;

  if r.camp_day_id is not distinct from p_new_day_id then
    id := r.id;
    reg_no := r.reg_no;
    full_name := r.full_name;
    camp_day_id := r.camp_day_id;
    day_date := v_new.day_date;
    return next;
    return;
  end if;

  select count(*)::int into v_taken
  from public.patients p
  where p.camp_day_id = p_new_day_id;

  if v_taken >= v_new.seat_limit then
    raise exception 'That day is full (% seats taken)', v_taken;
  end if;

  update public.patients p
  set camp_day_id = p_new_day_id
  where p.id = r.id
  returning p.id, p.reg_no, p.full_name, p.camp_day_id
    into r.id, r.reg_no, r.full_name, r.camp_day_id;

  id := r.id;
  reg_no := r.reg_no;
  full_name := r.full_name;
  camp_day_id := r.camp_day_id;
  day_date := v_new.day_date;
  return next;
end;
$$;

grant execute on function public.change_camp_day(uuid, uuid) to anon, authenticated;

-- Updated register_patient with day + capacity
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
  p_created_by uuid default null,
  p_camp_day_id uuid default null
)
returns table (id uuid, reg_no integer, full_name text, camp_day_id uuid, day_date date)
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
  v_day public.camp_days%rowtype;
  v_taken integer;
  v_row public.patients%rowtype;
begin
  v_name := trim(coalesce(p_full_name, ''));
  if length(v_name) = 0 then
    raise exception 'full_name required';
  end if;

  if not exists (select 1 from public.camps c where c.id = p_camp_id and c.is_active = true) then
    raise exception 'No active camp';
  end if;

  if p_camp_day_id is null then
    raise exception 'Please select a camp day';
  end if;

  select * into v_day from public.camp_days where camp_days.id = p_camp_day_id for update;
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
  v_phone10 := nullif(right(regexp_replace(coalesce(v_phone, ''), '\D', '', 'g'), 10), '');
  if v_phone10 is not null and length(v_phone10) < 10 then
    v_phone10 := null;
  end if;

  -- One registration per person per camp (any day)
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
      and right(regexp_replace(coalesce(p.phone, ''), '\D', '', 'g'), 10) = v_phone10
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
      and lower(trim(p.full_name)) = lower(v_name)
    limit 1;
    if v_existing_reg is not null then
      raise exception 'Already registered for this camp (reg no %). Change day instead.', v_existing_reg;
    end if;
  end if;

  if v_phone10 is null and v_aadhaar is null and p_age is not null then
    select p.reg_no into v_existing_reg
    from public.patients p
    where p.camp_id = p_camp_id
      and lower(trim(p.full_name)) = lower(v_name)
      and p.age = p_age
    limit 1;
    if v_existing_reg is not null then
      raise exception 'Already registered for this camp (reg no %). Change day instead.', v_existing_reg;
    end if;
  end if;

  insert into public.patients (
    camp_id, camp_day_id, user_id, full_name, gender, age, address, phone, email,
    aadhaar_last4, created_by, queue_status, queued_at
  ) values (
    p_camp_id,
    p_camp_day_id,
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
  returning
    public.patients.id,
    public.patients.reg_no,
    public.patients.full_name,
    public.patients.camp_day_id
  into
    v_row.id,
    v_row.reg_no,
    v_row.full_name,
    v_row.camp_day_id;

  id := v_row.id;
  reg_no := v_row.reg_no;
  full_name := v_row.full_name;
  camp_day_id := v_row.camp_day_id;
  day_date := v_day.day_date;
  return next;
end;
$$;

-- Drop old overload if signature changed (Postgres keeps both if arg lists differ)
-- Re-grant both possible signatures
grant execute on function public.register_patient(
  uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid
) to anon, authenticated;
