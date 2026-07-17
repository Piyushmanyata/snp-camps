-- Print marks patient seen; keep queued_at for FCFS history if they skipped scan.
create or replace function public.mark_patient_seen(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_staff() then
    raise exception 'staff only';
  end if;
  update public.patients
  set queue_status = 'seen',
      seen_at = coalesce(seen_at, now()),
      queued_at = coalesce(queued_at, now())
  where id = p_id;
end;
$$;

grant execute on function public.mark_patient_seen(uuid) to authenticated;
