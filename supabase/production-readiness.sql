-- Production least-privilege and concurrency alignment.
-- Apply after fix-security-and-account-claims.sql.

-- Supabase's default public-schema grants expose every new function through
-- PostgREST until it is explicitly revoked. Make least privilege the default.
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

-- Remove implicit execution from every existing application function before
-- granting back the small public/authenticated API surface below.
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  loop
    execute format(
      'revoke all on function %s from public, anon, authenticated',
      fn.signature
    );
  end loop;
end;
$$;

grant execute on function public.camp_day_stats(uuid) to anon, authenticated;
grant execute on function public.register_patient(
  uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid
) to anon, authenticated;

grant execute on function public.is_staff() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_doctor() to authenticated;
grant execute on function public.change_camp_day(uuid, uuid) to authenticated;
grant execute on function public.upsert_camp_day(uuid, date, integer, uuid) to authenticated;
grant execute on function public.delete_camp_day(uuid) to authenticated;
grant execute on function public.delete_camp(uuid) to authenticated;
grant execute on function public.set_active_camp(uuid) to authenticated;
grant execute on function public.assign_patient_doctor(uuid, integer, uuid) to authenticated;
grant execute on function public.mark_patient_printed(uuid) to authenticated;
grant execute on function public.join_queue(uuid, integer) to authenticated;
grant execute on function public.lookup_patient_scan(uuid, integer) to authenticated;
grant execute on function public.mark_patient_seen(uuid) to authenticated;
grant execute on function public.link_patient_phone(text) to authenticated;

-- Tables are reached either through these narrow policies or a validated RPC.
revoke all on table public.patients from anon;
revoke insert, update, delete, truncate, references, trigger
  on table public.patients from authenticated;
grant select, delete on table public.patients to authenticated;

revoke all on table public.profiles from anon;
revoke insert, delete, truncate, references, trigger
  on table public.profiles from authenticated;
grant select, update on table public.profiles to authenticated;

revoke all on table public.camps from anon, authenticated;
grant select on table public.camps to anon, authenticated;
grant insert, update, delete on table public.camps to authenticated;

revoke all on table public.camp_days from anon, authenticated;
grant select on table public.camp_days to anon, authenticated;
grant insert, update, delete on table public.camp_days to authenticated;

revoke all on all sequences in schema public from anon, authenticated;

-- One SELECT policy per role/table avoids repeated permissive-policy work.
drop policy if exists "admin camps" on public.camps;
drop policy if exists "public read active camp" on public.camps;
drop policy if exists "read camps" on public.camps;
create policy "anon read active camp" on public.camps
  for select to anon
  using (is_active = true);
create policy "authenticated read camps" on public.camps
  for select to authenticated
  using (true);
create policy "admin insert camps" on public.camps
  for insert to authenticated
  with check (public.is_admin());
create policy "admin update camps" on public.camps
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());
create policy "admin delete camps" on public.camps
  for delete to authenticated
  using (public.is_admin());

drop policy if exists "admin camp days" on public.camp_days;
drop policy if exists "read camp days" on public.camp_days;
create policy "anon read camp days" on public.camp_days
  for select to anon
  using (true);
create policy "authenticated read camp days" on public.camp_days
  for select to authenticated
  using (true);
create policy "admin insert camp days" on public.camp_days
  for insert to authenticated
  with check (public.is_admin());
create policy "admin update camp days" on public.camp_days
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());
create policy "admin delete camp days" on public.camp_days
  for delete to authenticated
  using (public.is_admin());

drop policy if exists "admin delete patients" on public.patients;
drop policy if exists "patient read own" on public.patients;
drop policy if exists "patient update own link" on public.patients;
drop policy if exists "read unlinked on active camp" on public.patients;
drop policy if exists "register on active camp" on public.patients;
drop policy if exists "staff insert patients" on public.patients;
drop policy if exists "staff select patients" on public.patients;
drop policy if exists "staff update patients" on public.patients;
create policy "authenticated read permitted patients" on public.patients
  for select to authenticated
  using (
    public.is_staff()
    or user_id = (select auth.uid())
  );
create policy "admin delete patients" on public.patients
  for delete to authenticated
  using (public.is_admin());

drop policy if exists "admin update any profile" on public.profiles;
drop policy if exists "read own profile" on public.profiles;
drop policy if exists "update own profile" on public.profiles;
drop policy if exists "update own patient profile" on public.profiles;
create policy "authenticated read permitted profiles" on public.profiles
  for select to authenticated
  using (
    id = (select auth.uid())
    or public.is_staff()
  );
create policy "authenticated update permitted profiles" on public.profiles
  for update to authenticated
  using (
    id = (select auth.uid())
    or public.is_admin()
  )
  with check (
    public.is_admin()
    or (
      id = (select auth.uid())
      and role = 'patient'
    )
  );

-- Lock the capacity row before counting so a concurrent registration cannot
-- race a seat-limit reduction.
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
    select d.* into r
    from public.camp_days d
    where d.id = p_day_id and d.camp_id = p_camp_id
    for update;
    if r.id is null then
      raise exception 'Day not found';
    end if;

    select count(*)::int into v_taken
    from public.patients p
    where p.camp_day_id = r.id;
    if p_seat_limit < v_taken then
      raise exception 'Cannot set seats below taken (%)', v_taken;
    end if;

    update public.camp_days d
    set day_date = p_day_date,
        seat_limit = p_seat_limit
    where d.id = r.id
    returning d.* into r;
    return r;
  end if;

  insert into public.camp_days (camp_id, day_date, seat_limit)
  values (p_camp_id, p_day_date, p_seat_limit)
  on conflict (camp_id, day_date)
  do update set seat_limit = excluded.seat_limit
  returning * into r;

  select count(*)::int into v_taken
  from public.patients p
  where p.camp_day_id = r.id;
  if r.seat_limit < v_taken then
    raise exception 'Cannot set seats below taken (%)', v_taken;
  end if;

  return r;
end;
$$;

revoke all on function public.upsert_camp_day(uuid, date, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.upsert_camp_day(uuid, date, integer, uuid)
  to authenticated;
