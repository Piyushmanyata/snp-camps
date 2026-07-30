-- #66 — Serialize camp-day capacity edits with registrations.
--
-- Defect: upsert_camp_day (p_day_id path) counted assigned patients BEFORE
-- acquiring the camp_days row lock. Registration correctly does
-- SELECT camp_days … FOR UPDATE then count then insert. A two-transaction
-- interleaving could let the edit read N, block behind a registration that
-- inserts patient N+1, then write seat_limit = N after that insert commits.
--
-- Lock order (shared capacity critical section — document & keep stable):
--   1. camp_days row lock: SELECT … FROM camp_days … FOR UPDATE
--      (by day id, or by camp_id + day_date for the upsert-by-date path)
--   2. Count patients assigned to that day (under the same lock)
--   3. UPDATE seat_limit / INSERT new day, or raise terminal capacity error
--
-- Registration (register_patient_idempotent) and change_camp_day acquire the
-- same camp_days row lock first for seat checks. Soft-duplicate advisory
-- locks (if any) are taken AFTER the day row lock. Camp-day edit never takes
-- soft locks. This single shared order avoids deadlock between edit and reg.
--
-- Capacity rejection uses a stable structured code so clients can map it
-- without treating a valid business rejection as connectivity:
--   SEAT_LIMIT_BELOW_ASSIGNED:taken=<n>
--
-- Append-only function migration; production data unchanged.

CREATE OR REPLACE FUNCTION public.upsert_camp_day(
  p_camp_id uuid,
  p_day_date date,
  p_seat_limit integer,
  p_day_id uuid DEFAULT NULL::uuid
)
RETURNS public.camp_days
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
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

  -- Existing-day edit by primary key: lock row before count/validate/update.
  if p_day_id is not null then
    select *
    into r
    from public.camp_days d
    where d.id = p_day_id
      and d.camp_id = p_camp_id
    for update;

    if r.id is null then
      raise exception 'Day not found';
    end if;

    select count(*)::integer
    into v_taken
    from public.patients p
    where p.camp_day_id = p_day_id;

    if p_seat_limit < v_taken then
      raise exception 'SEAT_LIMIT_BELOW_ASSIGNED:taken=%', v_taken;
    end if;

    update public.camp_days d
    set day_date = p_day_date,
        seat_limit = p_seat_limit
    where d.id = p_day_id
      and d.camp_id = p_camp_id
    returning d.* into r;

    return r;
  end if;

  -- Upsert-by-date: lock any existing row for (camp_id, day_date) before
  -- validating count / updating limit (same lock order as the id path).
  select *
  into r
  from public.camp_days d
  where d.camp_id = p_camp_id
    and d.day_date = p_day_date
  for update;

  if r.id is not null then
    select count(*)::integer
    into v_taken
    from public.patients p
    where p.camp_day_id = r.id;

    if p_seat_limit < v_taken then
      raise exception 'SEAT_LIMIT_BELOW_ASSIGNED:taken=%', v_taken;
    end if;

    update public.camp_days d
    set seat_limit = p_seat_limit
    where d.id = r.id
    returning d.* into r;

    return r;
  end if;

  -- New day: no assignments yet; insert only.
  insert into public.camp_days (camp_id, day_date, seat_limit)
  values (p_camp_id, p_day_date, p_seat_limit)
  returning * into r;

  return r;
end;
$function$;

COMMENT ON FUNCTION public.upsert_camp_day(uuid, date, integer, uuid) IS
  'Admin upsert of camp day / seat_limit. Lock order: camp_days FOR UPDATE, then count assigned patients, then update or SEAT_LIMIT_BELOW_ASSIGNED. Matches register_patient_idempotent day-row lock order (#66).';
