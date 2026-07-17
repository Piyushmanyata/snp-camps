-- Admin-only patient delete + grant DELETE
-- Replace broad staff FOR ALL (which also allowed volunteer delete)

drop policy if exists "staff all patients" on public.patients;
drop policy if exists "staff select patients" on public.patients;
drop policy if exists "staff insert patients" on public.patients;
drop policy if exists "staff update patients" on public.patients;
drop policy if exists "admin delete patients" on public.patients;

create policy "staff select patients" on public.patients
  for select using (public.is_staff());
create policy "staff insert patients" on public.patients
  for insert with check (public.is_staff());
create policy "staff update patients" on public.patients
  for update using (public.is_staff()) with check (public.is_staff());
create policy "admin delete patients" on public.patients
  for delete
  to authenticated
  using (public.is_admin());

grant select, insert, update, delete on public.patients to authenticated;
