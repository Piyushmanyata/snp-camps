-- Consolidated operational counters for staff dashboards.
create or replace function public.camp_queue_counts(p_camp_id uuid)
returns table (
  registered_count bigint,
  waiting_count bigint,
  seen_count bigint,
  total_count bigint
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
    count(*)
  from public.patients p
  where p.camp_id = p_camp_id;
end;
$$;

revoke all on function public.camp_queue_counts(uuid)
  from public, anon, authenticated;
grant execute on function public.camp_queue_counts(uuid) to authenticated;
