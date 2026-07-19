-- Lean high-traffic indexes + desk KPI RPCs (one round-trip instead of 4–5 counts).
-- Safe to re-run.

-- Hot path: waiting queue list (camp + FCFS order)
create index if not exists patients_camp_waiting_queued_idx
  on public.patients (camp_id, queued_at nulls last, created_at)
  where queue_status = 'waiting';

-- Hot path: camp day seat counts
create index if not exists patients_camp_day_id_idx
  on public.patients (camp_day_id)
  where camp_day_id is not null;

-- Active camp lookup
create index if not exists camps_is_active_idx
  on public.camps (is_active)
  where is_active = true;

-- Doctor counts lookup
create index if not exists patients_seen_by_seen_at_idx
  on public.patients (seen_by, seen_at)
  where seen_by is not null;

-- Volunteer counts lookup
create index if not exists patients_created_by_created_at_idx
  on public.patients (created_by, created_at)
  where created_by is not null;

-- Volunteer desk: all my counters in one call
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
  where p.created_by = auth.uid()
    and exists (
      select 1 from public.profiles pr
      where pr.id = auth.uid() and pr.role in ('admin', 'volunteer', 'doctor')
    );
$$;

revoke all on function public.volunteer_my_counts(timestamptz)
  from public, anon;
grant execute on function public.volunteer_my_counts(timestamptz) to authenticated;

-- Doctor desk: my seen counts in one call
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
    count(*) filter (
      where p.seen_at >= p_since
    )::bigint,
    count(*)::bigint
  from public.patients p
  where p.camp_id = p_camp_id
    and p.seen_by = auth.uid()
    and p.queue_status = 'seen'
    and exists (
      select 1 from public.profiles pr
      where pr.id = auth.uid() and pr.role = 'doctor'
    );
$$;

revoke all on function public.doctor_my_counts(uuid, timestamptz)
  from public, anon;
grant execute on function public.doctor_my_counts(uuid, timestamptz) to authenticated;

-- Drop hot tables from realtime publication if present (no live websockets)
do $$
declare
  t text;
begin
  foreach t in array array['patients', 'camp_days'] loop
    if exists (
      select 1
      from pg_publication pub
      join pg_publication_rel pr on pr.prpubid = pub.oid
      join pg_class c on c.oid = pr.prrelid
      join pg_namespace n on n.oid = c.relnamespace
      where pub.pubname = 'supabase_realtime'
        and n.nspname = 'public'
        and c.relname = t
    ) then
      execute format(
        'alter publication supabase_realtime drop table public.%I',
        t
      );
    end if;
  end loop;
exception
  when others then
    null;
end $$;

select 'lean-perf applied' as status;
