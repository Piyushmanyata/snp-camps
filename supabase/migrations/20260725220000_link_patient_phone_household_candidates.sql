-- #18 — Shared family phone: return candidates, never guess.
-- Zero match → no_match. One unlinked → link. Two+ → choose list (cap 10).
-- Second call with p_patient_id re-verifies phone + unlinked before linking.
-- Do not edit the baseline dump.

DROP FUNCTION IF EXISTS public.link_patient_phone(text);

CREATE FUNCTION public.link_patient_phone(
  p_phone text,
  p_patient_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
declare
  v_phone10 text;
  v_auth_phone text;
  v_phone_confirmed_at timestamptz;
  v_count integer;
  v_patient_id uuid;
  v_candidates jsonb;
  v_ask_desk boolean := false;
  v_existing_user uuid;
  v_updated int;
begin
  if auth.uid() is null then
    raise exception 'Sign in required';
  end if;

  if not exists (
    select 1
    from public.profiles
    where id = auth.uid() and role = 'patient'
  ) then
    raise exception 'Patient account required';
  end if;

  v_phone10 := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10);
  if length(v_phone10) <> 10 then
    raise exception 'Valid phone required';
  end if;

  select u.phone, u.phone_confirmed_at
  into v_auth_phone, v_phone_confirmed_at
  from auth.users u
  where u.id = auth.uid();

  if
    v_phone_confirmed_at is null
    or v_auth_phone is distinct from '+91' || v_phone10
  then
    raise exception 'Use the Indian phone number verified for this account';
  end if;

  -- Explicit choice (second call): re-verify candidate membership.
  if p_patient_id is not null then
    select p.user_id
    into v_existing_user
    from public.patients p
    join public.camps c on c.id = p.camp_id and c.is_active
    where p.id = p_patient_id
      and p.phone_normalized = v_phone10;

    if not found then
      raise exception 'Patient is not a candidate for this phone';
    end if;

    if v_existing_user is not null then
      if v_existing_user = auth.uid() then
        return jsonb_build_object(
          'status', 'linked',
          'patient_id', p_patient_id
        );
      end if;
      raise exception 'Patient is already linked';
    end if;

    update public.patients
    set user_id = auth.uid()
    where id = p_patient_id
      and user_id is null
      and phone_normalized = v_phone10;

    get diagnostics v_updated = row_count;
    if v_updated = 0 then
      raise exception 'Patient is not a candidate for this phone';
    end if;

    return jsonb_build_object(
      'status', 'linked',
      'patient_id', p_patient_id
    );
  end if;

  -- First call: only unlinked patients on active camps.
  select count(*)::int
  into v_count
  from public.patients p
  join public.camps c on c.id = p.camp_id and c.is_active
  where p.phone_normalized = v_phone10
    and p.user_id is null;

  if v_count = 0 then
    return jsonb_build_object('status', 'no_match');
  end if;

  if v_count = 1 then
    select p.id
    into v_patient_id
    from public.patients p
    join public.camps c on c.id = p.camp_id and c.is_active
    where p.phone_normalized = v_phone10
      and p.user_id is null
    limit 1;

    update public.patients
    set user_id = auth.uid()
    where id = v_patient_id
      and user_id is null;

    get diagnostics v_updated = row_count;
    if v_updated = 0 then
      return jsonb_build_object('status', 'no_match');
    end if;

    return jsonb_build_object(
      'status', 'linked',
      'patient_id', v_patient_id
    );
  end if;

  v_ask_desk := v_count > 10;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', q.id,
        'reg_no', q.reg_no,
        'full_name', q.full_name,
        'camp_day', q.camp_day
      )
      order by q.created_at asc, q.reg_no asc
    ),
    '[]'::jsonb
  )
  into v_candidates
  from (
    select
      p.id,
      p.reg_no,
      p.full_name,
      cd.day_date::text as camp_day,
      p.created_at
    from public.patients p
    join public.camps c on c.id = p.camp_id and c.is_active
    left join public.camp_days cd on cd.id = p.camp_day_id
    where p.phone_normalized = v_phone10
      and p.user_id is null
    order by p.created_at asc, p.reg_no asc
    limit 10
  ) q;

  return jsonb_build_object(
    'status', 'choose',
    'candidates', v_candidates,
    'ask_desk', v_ask_desk
  );
end;
$$;

ALTER FUNCTION public.link_patient_phone(text, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.link_patient_phone(text, uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.link_patient_phone(text, uuid) TO service_role;
GRANT ALL ON FUNCTION public.link_patient_phone(text, uuid) TO authenticated;

-- Contract probe: new (text, uuid) signature replaces (text).
CREATE OR REPLACE FUNCTION public.app_database_contract() RETURNS text
    LANGUAGE sql
    STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select case
    when to_regprocedure(
      'public.register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid)'
    ) is not null
      and to_regprocedure('public.doctor_recent_patients(uuid,integer)') is not null
      and to_regprocedure('public.link_patient_phone(text,uuid)') is not null
      and exists (
        select 1
        from pg_catalog.pg_attribute a
        join pg_catalog.pg_class c on c.oid = a.attrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname = 'patients'
          and a.attname = 'registration_request_id'
          and a.attnum > 0
          and not a.attisdropped
      )
      and exists (
        select 1
        from pg_catalog.pg_attribute a
        join pg_catalog.pg_class c on c.oid = a.attrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname = 'patients'
          and a.attname = 'passcode_issued_at'
          and a.attnum > 0
          and not a.attisdropped
      )
    then '20260722005000'
    else 'incomplete'
  end;
$$;

ALTER FUNCTION public.app_database_contract() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.app_database_contract() FROM PUBLIC;
GRANT ALL ON FUNCTION public.app_database_contract() TO service_role;
