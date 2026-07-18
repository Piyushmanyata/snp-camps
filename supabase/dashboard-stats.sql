-- Consolidated operational counters for staff dashboards.
-- Includes average wait minutes: queued_at (or created_at) → seen_at for doctor-seen patients.
create or replace function public.camp_queue_counts(p_camp_id uuid)
returns table (
  registered_count bigint,
  waiting_count bigint,
  seen_count bigint,
  total_count bigint,
  avg_wait_minutes numeric
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_staff() then
    raise exception 'staff only';
  end if;

  return query
  select
    count(*) filter (where p.queue_status = 'registered'),
    count(*) filter (where p.queue_status = 'waiting'),
    count(*) filter (where p.queue_status = 'seen'),
    count(*),
    round(
      (
        avg(
          extract(
            epoch from (
              p.seen_at - coalesce(p.queued_at, p.created_at)
            )
          ) / 60.0
        ) filter (
          where p.queue_status = 'seen'
            and p.seen_at is not null
            and coalesce(p.queued_at, p.created_at) is not null
            and p.seen_at >= coalesce(p.queued_at, p.created_at)
        )
      )::numeric,
      1
    ) as avg_wait_minutes
  from public.patients p
  where p.camp_id = p_camp_id;
end;
$$;

revoke all on function public.camp_queue_counts(uuid)
  from public, anon, authenticated;
grant execute on function public.camp_queue_counts(uuid) to authenticated;
