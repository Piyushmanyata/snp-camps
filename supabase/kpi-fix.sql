-- Desk KPI reliability: camp-scoped volunteer counts, doctor counts for staff,
-- and admin staff_person_kpis for volunteer/doctor detail panels.
-- Safe to re-run.

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
set search_path = public
as $$
  select
    count(*)::bigint,
    count(*) filter (where p.created_at >= p_since)::bigint,
    count(*) filter (where p.queue_status = 'waiting')::bigint,
    count(*) filter (where p.queue_status = 'seen')::bigint
  from public.patients p
  where (p.created_by = auth.uid() or p.checked_in_by = auth.uid())
    and (
      -- Prefer active camp when one exists; else all camps
      not exists (select 1 from public.camps c where c.is_active)
      or p.camp_id = (select c.id from public.camps c where c.is_active limit 1)
    )
    and exists (
      select 1 from public.profiles pr
      where pr.id = auth.uid() and pr.role in ('admin', 'volunteer', 'doctor')
    );
$$;

revoke all on function public.volunteer_my_counts(timestamptz)
  from public, anon;
grant execute on function public.volunteer_my_counts(timestamptz) to authenticated;

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
set search_path = public
as $$
  select
    count(*) filter (where p.seen_at >= p_since)::bigint,
    count(*)::bigint
  from public.patients p
  where p.camp_id = p_camp_id
    and p.seen_by = auth.uid()
    and p.queue_status = 'seen'
    and exists (
      select 1 from public.profiles pr
      where pr.id = auth.uid() and pr.role in ('doctor', 'admin')
    );
$$;

revoke all on function public.doctor_my_counts(uuid, timestamptz)
  from public, anon;
grant execute on function public.doctor_my_counts(uuid, timestamptz) to authenticated;

-- Admin/staff detail panel: one round-trip KPIs for any doctor/volunteer
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
set search_path = public
as $$
declare
  v_since timestamptz := coalesce(p_since, date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata');
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  -- Admin can view anyone; others only themselves matching role
  if not public.is_admin() then
    if auth.uid() is distinct from p_user_id then
      raise exception 'forbidden';
    end if;
    if not exists (
      select 1 from public.profiles pr
      where pr.id = auth.uid() and pr.role = p_role
    ) then
      raise exception 'forbidden';
    end if;
  end if;

  if p_role = 'doctor' then
    return query
    select
      count(*)::bigint as total,
      count(*) filter (where p.seen_at >= v_since)::bigint as today,
      0::bigint as waiting,
      count(*)::bigint as seen,
      'Patients seen'::text as label
    from public.patients p
    where p.seen_by = p_user_id
      and p.queue_status = 'seen'
      and (p_camp_id is null or p.camp_id = p_camp_id);
  elsif p_role = 'volunteer' then
    return query
    select
      count(*)::bigint as total,
      count(*) filter (where p.created_at >= v_since)::bigint as today,
      count(*) filter (where p.queue_status = 'waiting')::bigint as waiting,
      count(*) filter (where p.queue_status = 'seen')::bigint as seen,
      'Patients registered'::text as label
    from public.patients p
    where (p.created_by = p_user_id or p.checked_in_by = p_user_id)
      and (p_camp_id is null or p.camp_id = p_camp_id);
  else
    raise exception 'invalid role';
  end if;
end;
$$;

revoke all on function public.staff_person_kpis(uuid, text, uuid, timestamptz)
  from public, anon;
grant execute on function public.staff_person_kpis(uuid, text, uuid, timestamptz) to authenticated;

create index if not exists patients_created_by_camp_idx
  on public.patients (created_by, camp_id)
  where created_by is not null;

create index if not exists patients_seen_by_camp_idx
  on public.patients (seen_by, camp_id)
  where seen_by is not null;

select 'kpi-fix applied' as status;