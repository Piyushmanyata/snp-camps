-- Consolidate the live security/performance drift left by historical rollout
-- files. This migration is idempotent and must run after registration SQL.

begin;

-- These RPCs are either authenticated staff operations or server-side service
-- role operations; none should be callable by PUBLIC or the anonymous role.
revoke all on function public.register_patient(
  uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.register_patient(
  uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid
) to authenticated, service_role;

revoke all on function public.camp_day_stats(uuid)
  from public, anon;
grant execute on function public.camp_day_stats(uuid)
  to authenticated, service_role;

revoke all on function public.change_camp_day(uuid, uuid)
  from public, anon;
grant execute on function public.change_camp_day(uuid, uuid)
  to authenticated, service_role;

revoke all on function public.delete_camp_day(uuid)
  from public, anon;
grant execute on function public.delete_camp_day(uuid)
  to authenticated, service_role;

revoke all on function public.upsert_camp_day(uuid, date, integer, uuid)
  from public, anon;
grant execute on function public.upsert_camp_day(uuid, date, integer, uuid)
  to authenticated, service_role;

revoke all on function public.is_staff() from public, anon;
grant execute on function public.is_staff() to authenticated, service_role;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated, service_role;

-- Replace historical overlapping policies with one policy per role and action.
-- The scalar subqueries prevent auth functions from being re-evaluated for
-- every row in a query (Supabase auth_rls_initplan advisor finding).
drop policy if exists "admin camps" on public.camps;
drop policy if exists "admin delete camps" on public.camps;
drop policy if exists "admin insert camps" on public.camps;
drop policy if exists "admin update camps" on public.camps;
drop policy if exists "anon read active camp" on public.camps;
drop policy if exists "authenticated read camps" on public.camps;
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
  with check ((select public.is_admin()));
create policy "admin update camps" on public.camps
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));
create policy "admin delete camps" on public.camps
  for delete to authenticated
  using ((select public.is_admin()));

drop policy if exists "admin camp days" on public.camp_days;
drop policy if exists "admin delete camp days" on public.camp_days;
drop policy if exists "admin insert camp days" on public.camp_days;
drop policy if exists "admin update camp days" on public.camp_days;
drop policy if exists "anon read camp days" on public.camp_days;
drop policy if exists "authenticated read camp days" on public.camp_days;
drop policy if exists "read camp days" on public.camp_days;

create policy "anon read camp days" on public.camp_days
  for select to anon
  using (true);
create policy "authenticated read camp days" on public.camp_days
  for select to authenticated
  using (true);
create policy "admin insert camp days" on public.camp_days
  for insert to authenticated
  with check ((select public.is_admin()));
create policy "admin update camp days" on public.camp_days
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));
create policy "admin delete camp days" on public.camp_days
  for delete to authenticated
  using ((select public.is_admin()));

drop policy if exists "admin delete patients" on public.patients;
drop policy if exists "patient read own" on public.patients;
drop policy if exists "patient update own link" on public.patients;
drop policy if exists "read unlinked on active camp" on public.patients;
drop policy if exists "register on active camp" on public.patients;
drop policy if exists "staff insert patients" on public.patients;
drop policy if exists "staff select patients" on public.patients;
drop policy if exists "staff update patients" on public.patients;
drop policy if exists "authenticated read permitted patients" on public.patients;

create policy "authenticated read permitted patients" on public.patients
  for select to authenticated
  using (
    (select public.is_staff())
    or user_id = (select auth.uid())
  );
create policy "admin delete patients" on public.patients
  for delete to authenticated
  using ((select public.is_admin()));

drop policy if exists "admin update any profile" on public.profiles;
drop policy if exists "read own profile" on public.profiles;
drop policy if exists "update own profile" on public.profiles;
drop policy if exists "update own patient profile" on public.profiles;
drop policy if exists "authenticated read permitted profiles" on public.profiles;
drop policy if exists "authenticated update permitted profiles" on public.profiles;

create policy "authenticated read permitted profiles" on public.profiles
  for select to authenticated
  using (
    id = (select auth.uid())
    or (select public.is_staff())
  );
create policy "authenticated update permitted profiles" on public.profiles
  for update to authenticated
  using (
    id = (select auth.uid())
    or (select public.is_admin())
  )
  with check (
    (select public.is_admin())
    or (
      id = (select auth.uid())
      and role = 'patient'
    )
  );

commit;

notify pgrst, 'reload schema';
