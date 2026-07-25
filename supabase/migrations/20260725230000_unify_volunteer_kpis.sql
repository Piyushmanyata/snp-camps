-- #20 / D9: One volunteer KPI definition.
-- Keep staff_person_kpis; drop volunteer_my_counts.
-- Null p_camp_id means "no camp scoped" → zeros (not all-time totals).

DROP FUNCTION IF EXISTS public.volunteer_my_counts(timestamp with time zone);

CREATE OR REPLACE FUNCTION public.staff_person_kpis(
  p_user_id uuid,
  p_role text,
  p_camp_id uuid DEFAULT NULL,
  p_since timestamp with time zone DEFAULT NULL
)
RETURNS TABLE(
  total bigint,
  today bigint,
  waiting bigint,
  seen bigint,
  label text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
declare
  v_caller_id uuid := auth.uid();
  v_caller_role public.user_role;
  v_since timestamptz := coalesce(
    p_since,
    date_trunc('day', now() at time zone 'Asia/Kolkata')
      at time zone 'Asia/Kolkata'
  );
  v_label text;
begin
  if v_caller_id is null then
    raise exception 'not authenticated';
  end if;

  select p.role
  into v_caller_role
  from public.profiles p
  where p.id = v_caller_id
    and p.role in ('admin', 'volunteer', 'doctor')
    and p.disabled_at is null;

  if v_caller_role is null then
    raise exception 'active staff only';
  end if;

  if v_caller_role <> 'admin' then
    if v_caller_id is distinct from p_user_id
      or v_caller_role::text is distinct from p_role
    then
      raise exception 'forbidden';
    end if;
  end if;

  if p_role = 'doctor' then
    v_label := 'Patients seen';
  elsif p_role = 'volunteer' then
    v_label := 'Patients handled';
  else
    raise exception 'invalid role';
  end if;

  -- No explicit camp → zeros. Never fall back to all-time career totals.
  if p_camp_id is null then
    return query
    select
      0::bigint,
      0::bigint,
      0::bigint,
      0::bigint,
      v_label;
    return;
  end if;

  if p_role = 'doctor' then
    return query
    select
      count(*)::bigint,
      count(*) filter (where p.seen_at >= v_since)::bigint,
      0::bigint,
      count(*)::bigint,
      v_label
    from public.patients p
    where p.seen_by = p_user_id
      and p.queue_status = 'seen'
      and p.camp_id = p_camp_id;
  else
    -- p_role = 'volunteer' (validated above)
    return query
    select
      count(*)::bigint,
      count(*) filter (
        where (p.created_by = p_user_id and p.created_at >= v_since)
          or (
            p.checked_in_by = p_user_id
            and coalesce(p.queued_at, p.seen_at, p.created_at) >= v_since
          )
      )::bigint,
      count(*) filter (where p.queue_status = 'waiting')::bigint,
      count(*) filter (where p.queue_status = 'seen')::bigint,
      v_label
    from public.patients p
    where (p.created_by = p_user_id or p.checked_in_by = p_user_id)
      and p.camp_id = p_camp_id;
  end if;
end;
$$;

ALTER FUNCTION public.staff_person_kpis(
  uuid, text, uuid, timestamp with time zone
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.staff_person_kpis(
  uuid, text, uuid, timestamp with time zone
) FROM PUBLIC;
GRANT ALL ON FUNCTION public.staff_person_kpis(
  uuid, text, uuid, timestamp with time zone
) TO service_role;
GRANT ALL ON FUNCTION public.staff_person_kpis(
  uuid, text, uuid, timestamp with time zone
) TO authenticated;
