-- Once a patient is in the live queue (waiting) or seen, camp day cannot change.
-- Registered-only patients may still switch days while seats remain.

create or replace function public.change_camp_day(
  p_patient_id uuid,
  p_new_day_id uuid
)
returns table (
  id uuid,
  reg_no integer,
  full_name text,
  camp_day_id uuid,
  day_date date
)
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.patients%rowtype;
  v_new public.camp_days%rowtype;
  v_taken integer;
begin
  select * into r from public.patients p where p.id = p_patient_id for update;
  if r.id is null then
    raise exception 'Patient not found';
  end if;

  if r.queue_status in ('waiting', 'seen') then
    raise exception 'Cannot change camp day after joining the queue';
  end if;

  if not public.is_staff() then
    if auth.uid() is null or r.user_id is distinct from auth.uid() then
      raise exception 'Not allowed';
    end if;
  end if;

  select * into v_new from public.camp_days d where d.id = p_new_day_id for update;
  if v_new.id is null then
    raise exception 'Day not found';
  end if;
  if v_new.camp_id is distinct from r.camp_id then
    raise exception 'Day does not belong to this camp';
  end if;

  if r.camp_day_id is not distinct from p_new_day_id then
    id := r.id;
    reg_no := r.reg_no;
    full_name := r.full_name;
    camp_day_id := r.camp_day_id;
    day_date := v_new.day_date;
    return next;
    return;
  end if;

  select count(*)::int into v_taken
  from public.patients p
  where p.camp_day_id = p_new_day_id;

  if v_taken >= v_new.seat_limit then
    raise exception 'That day is full (% seats taken)', v_taken;
  end if;

  update public.patients p
  set camp_day_id = p_new_day_id
  where p.id = r.id
  returning p.id, p.reg_no, p.full_name, p.camp_day_id, p.user_id, p.camp_id
    into r.id, r.reg_no, r.full_name, r.camp_day_id, r.user_id, r.camp_id;

  id := r.id;
  reg_no := r.reg_no;
  full_name := r.full_name;
  camp_day_id := r.camp_day_id;
  day_date := v_new.day_date;
  return next;
end;
$$;

grant execute on function public.change_camp_day(uuid, uuid) to anon, authenticated;
