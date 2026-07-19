-- Public home/register snapshot: one round-trip for camp metadata + seats.
-- Safe to re-run. Registration capacity remains enforced by register_patient.

create or replace function public.active_camp_snapshot()
returns table (
  id uuid,
  name text,
  venue text,
  camp_date date,
  days jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id,
    c.name,
    c.venue,
    c.camp_date,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', d.id,
            'camp_id', d.camp_id,
            'day_date', d.day_date,
            'seat_limit', d.seat_limit,
            'seats_taken', d.seats_taken,
            'seats_left', d.seats_left,
            'is_full', d.is_full
          )
          order by d.day_date
        )
        from (
          select
            cd.id,
            cd.camp_id,
            cd.day_date,
            cd.seat_limit,
            count(p.id)::integer as seats_taken,
            greatest(cd.seat_limit - count(p.id)::integer, 0) as seats_left,
            (count(p.id)::integer >= cd.seat_limit) as is_full
          from public.camp_days cd
          left join public.patients p on p.camp_day_id = cd.id
          where cd.camp_id = c.id
          group by cd.id, cd.camp_id, cd.day_date, cd.seat_limit
        ) d
      ),
      '[]'::jsonb
    ) as days
  from public.camps c
  where c.is_active = true
  limit 1;
$$;

revoke all on function public.active_camp_snapshot() from public;
grant execute on function public.active_camp_snapshot() to anon, authenticated;

select 'performance snapshot applied' as status;
