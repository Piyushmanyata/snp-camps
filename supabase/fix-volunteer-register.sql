-- Volunteer / staff desk registration hardening.
-- Ensures authenticated staff can execute register_patient and desk KPI RPCs.
-- Safe to re-run.

-- Staff check includes volunteer (and doctor, admin)
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

revoke all on function public.is_staff() from public;
grant execute on function public.is_staff() to anon, authenticated;

-- Desk registration RPC: staff via authenticated session; service_role for API self-reg
grant execute on function public.register_patient(
  uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid
) to authenticated, service_role;

-- Anon must not call direct register (API uses service_role)
revoke execute on function public.register_patient(
  uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid
) from anon;

-- Volunteer KPI RPC (desk header counters)
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
  where p.created_by = auth.uid();
$$;

revoke all on function public.volunteer_my_counts(timestamptz)
  from public, anon;
grant execute on function public.volunteer_my_counts(timestamptz) to authenticated;

-- Help staff find their own walk-ins quickly
create index if not exists patients_created_by_created_at_idx
  on public.patients (created_by, created_at desc)
  where created_by is not null;
