-- Indexes for doctor/volunteer KPI lookups on staff desks.
-- Safe to re-run.

create index if not exists patients_seen_by_idx
  on public.patients (seen_by)
  where seen_by is not null;

create index if not exists patients_created_by_idx
  on public.patients (created_by)
  where created_by is not null;

create index if not exists patients_seen_by_seen_at_idx
  on public.patients (seen_by, seen_at desc)
  where queue_status = 'seen' and seen_by is not null;

-- Service-role phone OTP self-registration already uses register_patient.
-- Ensure authenticated patients can read their own rows (existing RLS).
select 'staff-kpis-indexes applied' as status;
