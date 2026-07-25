-- SNP Camps baseline schema (squashed migration lineage).
-- Reproduces the full post-lineage schema on an empty database.
-- Source: reviewed production dump (PostgreSQL 17.6) previously at supabase/schema.sql.
-- Future schema changes: npx supabase migration new <name> then apply via CLI.
-- Do NOT re-run this baseline against a database that already has the schema.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: queue_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.queue_status AS ENUM (
    'registered',
    'waiting',
    'seen'
);


--
-- Name: user_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_role AS ENUM (
    'admin',
    'volunteer',
    'doctor',
    'patient'
);


--
-- Name: active_camp_snapshot(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.active_camp_snapshot() RETURNS TABLE(id uuid, name text, venue text, camp_date date, days jsonb)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: assign_patient_doctor(uuid, integer, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assign_patient_doctor(p_patient_id uuid DEFAULT NULL::uuid, p_reg_no integer DEFAULT NULL::integer, p_doctor_id uuid DEFAULT NULL::uuid) RETURNS TABLE(id uuid, reg_no integer, full_name text, queue_status public.queue_status, doctor_id uuid, doctor_name text, already_seen boolean, error_code text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  r public.patients%rowtype;
  v_caller_role public.user_role;
  v_doctor_id uuid;
  v_doctor_name text;
begin
  select p.role
  into v_caller_role
  from public.profiles p
  where p.id = (select auth.uid())
    and p.role in ('admin', 'volunteer', 'doctor')
    and p.disabled_at is null;

  if v_caller_role is null then
    raise exception 'active staff only';
  end if;

  if p_patient_id is not null then
    select *
    into r
    from public.patients p
    where p.id = p_patient_id
    for update;
  elsif p_reg_no is not null then
    select *
    into r
    from public.patients p
    where p.reg_no = p_reg_no
    for update;
  else
    raise exception 'Provide patient id or reg no';
  end if;

  if r.id is null then
    raise exception 'Patient not found';
  end if;

  if not exists (
    select 1
    from public.camps c
    where c.id = r.camp_id
      and c.is_active
  ) then
    raise exception 'Patient belongs to an inactive camp';
  end if;

  -- A completed assignment is immutable, including its original doctor.
  if r.queue_status = 'seen' then
    select p.full_name
    into v_doctor_name
    from public.profiles p
    where p.id = r.seen_by;

    return query
    select
      r.id,
      r.reg_no,
      r.full_name,
      r.queue_status,
      r.seen_by,
      coalesce(v_doctor_name, 'Unknown'),
      true,
      'already_seen'::text;
    return;
  end if;

  if r.queue_status is null
    or r.queue_status not in ('registered', 'waiting')
  then
    raise exception 'Unsupported patient queue status';
  end if;

  if v_caller_role = 'doctor' then
    v_doctor_id := (select auth.uid());
  elsif p_doctor_id is not null then
    v_doctor_id := p_doctor_id;
  else
    return query
    select
      r.id,
      r.reg_no,
      r.full_name,
      r.queue_status,
      null::uuid,
      null::text,
      false,
      'doctor_required'::text;
    return;
  end if;

  select p.full_name
  into v_doctor_name
  from public.profiles p
  where p.id = v_doctor_id
    and p.role = 'doctor'
    and p.disabled_at is null;

  if not found then
    raise exception 'Invalid or disabled doctor';
  end if;

  update public.patients p
  set queue_status = 'seen',
      seen_at = now(),
      seen_by = v_doctor_id,
      checked_in_by = coalesce(p.checked_in_by, (select auth.uid()))
  where p.id = r.id
  returning p.* into r;

  return query
  select
    r.id,
    r.reg_no,
    r.full_name,
    r.queue_status,
    r.seen_by,
    coalesce(v_doctor_name, 'Doctor'),
    false,
    null::text;
end;
$$;


--
-- Name: FUNCTION assign_patient_doctor(p_patient_id uuid, p_reg_no integer, p_doctor_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.assign_patient_doctor(p_patient_id uuid, p_reg_no integer, p_doctor_id uuid) IS 'Staff QR scan: assign doctor and mark seen. Doctors may scan without prior print.';


--
-- Name: camp_day_stats(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.camp_day_stats(p_camp_id uuid DEFAULT NULL::uuid) RETURNS TABLE(id uuid, camp_id uuid, day_date date, seat_limit integer, seats_taken integer, seats_left integer, is_full boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  with target as (
    select coalesce(
      p_camp_id,
      (select c.id from public.camps c where c.is_active = true limit 1)
    ) as camp_id
  )
  select
    d.id,
    d.camp_id,
    d.day_date,
    d.seat_limit,
    count(p.id)::integer as seats_taken,
    greatest(d.seat_limit - count(p.id)::integer, 0) as seats_left,
    (count(p.id)::integer >= d.seat_limit) as is_full
  from public.camp_days d
  cross join target t
  left join public.patients p on p.camp_day_id = d.id
  where d.camp_id = t.camp_id
  group by d.id, d.camp_id, d.day_date, d.seat_limit
  order by d.day_date;
$$;


--
-- Name: camp_queue_counts(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.camp_queue_counts(p_camp_id uuid) RETURNS TABLE(registered_count bigint, waiting_count bigint, seen_count bigint, total_count bigint, avg_wait_minutes numeric)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: change_camp_day(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.change_camp_day(p_patient_id uuid, p_new_day_id uuid) RETURNS TABLE(id uuid, reg_no integer, full_name text, camp_day_id uuid, day_date date)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  r public.patients%rowtype;
  v_new public.camp_days%rowtype;
  v_taken integer;
  v_camp_active boolean;
begin
  select *
  into r
  from public.patients p
  where p.id = p_patient_id
  for update;

  if r.id is null then
    raise exception 'Patient not found';
  end if;

  select c.is_active
  into v_camp_active
  from public.camps c
  where c.id = r.camp_id
  for share;

  if v_camp_active is distinct from true then
    raise exception 'Camp is no longer active';
  end if;

  if r.queue_status in ('waiting', 'seen') then
    raise exception 'Cannot change camp day after joining the queue';
  end if;

  if not public.is_staff() then
    if (select auth.uid()) is null
      or r.user_id is distinct from (select auth.uid())
    then
      raise exception 'Not allowed';
    end if;
  end if;

  select *
  into v_new
  from public.camp_days d
  where d.id = p_new_day_id
  for update;

  if v_new.id is null then
    raise exception 'Day not found';
  end if;
  if v_new.camp_id is distinct from r.camp_id then
    raise exception 'Day does not belong to this camp';
  end if;

  if r.camp_day_id is not distinct from p_new_day_id then
    return query
    select r.id, r.reg_no, r.full_name, r.camp_day_id, v_new.day_date;
    return;
  end if;

  select count(*)::integer
  into v_taken
  from public.patients p
  where p.camp_day_id = p_new_day_id;

  if v_taken >= v_new.seat_limit then
    raise exception 'That day is full (% seats taken)', v_taken;
  end if;

  update public.patients p
  set camp_day_id = p_new_day_id
  where p.id = r.id
  returning p.* into r;

  return query
  select r.id, r.reg_no, r.full_name, r.camp_day_id, v_new.day_date;
end;
$$;


--
-- Name: delete_camp(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_camp(p_camp_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_count integer;
  v_was_active boolean;

begin
  if not public.is_admin() then
    raise exception 'admin only';
  end if;

  if not exists (select 1 from public.camps c where c.id = p_camp_id) then
    raise exception 'Camp not found';
  end if;

  select count(*)::int into v_count
  from public.patients p
  where p.camp_id = p_camp_id;

  if v_count > 0 then
    raise exception 'Cannot delete camp with % patient(s). Remove patients first.', v_count;
  end if;

  select c.is_active into v_was_active from public.camps c where c.id = p_camp_id;

  -- camp_days cascade from camps; days with no patients are safe
  delete from public.camp_days d where d.camp_id = p_camp_id;
  delete from public.camps c where c.id = p_camp_id;

  -- if we deleted the active camp, leave none active (admin re-activates another)
  if v_was_active then
    null;
  end if;
end;
$$;


--
-- Name: delete_camp_day(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_camp_day(p_day_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not public.is_admin() then
    raise exception 'admin only';
  end if;
  if exists (select 1 from public.patients p where p.camp_day_id = p_day_id) then
    raise exception 'Cannot delete a day that has patients ? reassign them first';
  end if;
  delete from public.camp_days d where d.id = p_day_id;
end;
$$;


--
-- Name: doctor_my_counts(uuid, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.doctor_my_counts(p_camp_id uuid, p_since timestamp with time zone) RETURNS TABLE(seen_today bigint, seen_total bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select
    count(*) filter (where p.seen_at >= p_since)::bigint,
    count(*)::bigint
  from public.patients p
  where p.camp_id = p_camp_id
    and p.seen_by = (select auth.uid())
    and p.queue_status = 'seen'
    and exists (
      select 1
      from public.profiles pr
      where pr.id = (select auth.uid())
        and pr.role in ('doctor', 'admin')
        and pr.disabled_at is null
    );
$$;


--
-- Name: doctor_recent_patients(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.doctor_recent_patients(p_camp_id uuid, p_limit integer DEFAULT 50) RETURNS TABLE(id uuid, reg_no integer, full_name text, seen_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if not public.is_doctor() then raise exception 'doctor only'; end if;

  return query
  select p.id, p.reg_no, p.full_name, p.seen_at
  from public.patients p
  where p.camp_id = p_camp_id
    and p.seen_by = (select auth.uid())
    and p.queue_status = 'seen'
  order by p.seen_at desc nulls last
  limit least(greatest(coalesce(p_limit, 50), 1), 100);
end;
$$;


--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  insert into public.profiles (id, role, full_name, phone, email)
  values (
    new.id,
    'patient',
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    coalesce(new.phone, new.raw_user_meta_data->>'phone', null),
    new.email
  );
  return new;
end;
$$;


--
-- Name: is_admin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'admin'
      and p.disabled_at is null
  );
$$;


--
-- Name: is_doctor(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_doctor() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'doctor'
      and p.disabled_at is null
  );
$$;


--
-- Name: is_staff(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_staff() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.role in ('admin', 'volunteer')
      and p.disabled_at is null
  );
$$;


--
-- Name: link_patient_phone(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.link_patient_phone(p_phone text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  v_phone10 text;
  v_count integer;
  v_patient_id uuid;
  v_auth_phone text;
  v_phone_confirmed_at timestamptz;
begin
   if auth.uid() is null then raise exception 'Sign in required'; end if;
   if not exists (
     select 1
     from public.profiles
     where id = auth.uid() and role = 'patient'
   ) then
     raise exception 'Patient account required';
   end if;
   v_phone10 := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10);
  if length(v_phone10) <> 10 then raise exception 'Valid phone required'; end if;

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

  select count(*)::int, (array_agg(p.id order by p.created_at desc))[1]
  into v_count, v_patient_id
  from public.patients p
  join public.camps c on c.id = p.camp_id and c.is_active
  where p.phone_normalized = v_phone10;

  if v_count = 0 then return null; end if;

  update public.patients
  set user_id = auth.uid()
  where id = v_patient_id;

  return v_patient_id;
end;
$$;


--
-- Name: lookup_patient_scan(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lookup_patient_scan(p_patient_id uuid DEFAULT NULL::uuid, p_reg_no integer DEFAULT NULL::integer) RETURNS TABLE(id uuid, reg_no integer, full_name text, queue_status public.queue_status, phone text, doctor_id uuid, doctor_name text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  r public.patients%rowtype;
  v_caller_role public.user_role;
  v_doctor_name text;
begin
  select p.role
  into v_caller_role
  from public.profiles p
  where p.id = (select auth.uid())
    and p.role in ('admin', 'volunteer', 'doctor')
    and p.disabled_at is null;

  if v_caller_role is null then
    raise exception 'active staff only';
  end if;

  if p_patient_id is not null then
    select * into r
    from public.patients p
    where p.id = p_patient_id;
  elsif p_reg_no is not null then
    select * into r
    from public.patients p
    where p.reg_no = p_reg_no;
  else
    raise exception 'Provide patient id or reg no';
  end if;

  if r.id is null then
    raise exception 'Patient not found';
  end if;

  if not exists (
    select 1
    from public.camps c
    where c.id = r.camp_id
      and c.is_active
  ) then
    raise exception 'Patient belongs to an inactive camp';
  end if;

  if r.seen_by is not null then
    select p.full_name
    into v_doctor_name
    from public.profiles p
    where p.id = r.seen_by;
  end if;

  return query
  select
    r.id,
    r.reg_no,
    r.full_name,
    r.queue_status,
    case when v_caller_role = 'doctor' then null::text else r.phone end,
    r.seen_by,
    v_doctor_name;
end;
$$;


--
-- Name: FUNCTION lookup_patient_scan(p_patient_id uuid, p_reg_no integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.lookup_patient_scan(p_patient_id uuid, p_reg_no integer) IS 'Staff-only patient lookup for QR/reg scan. No side effects. QR is not for patient login.';


--
-- Name: mark_patient_printed(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_patient_printed(p_id uuid) RETURNS TABLE(id uuid, reg_no integer, full_name text, queue_status public.queue_status, already_printed boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  r public.patients%rowtype;
  v_already boolean;
begin
  if not public.is_staff() then
    raise exception 'staff only';
  end if;

  select *
  into r
  from public.patients p
  where p.id = p_id
  for update;

  if r.id is null then
    raise exception 'Patient not found';
  end if;
  if not exists (
    select 1
    from public.camps c
    where c.id = r.camp_id
      and c.is_active
  ) then
    raise exception 'Patient belongs to an inactive camp';
  end if;

  v_already := r.printed_at is not null;

  if r.queue_status = 'seen' then
    if r.printed_at is null then
      update public.patients p
      set printed_at = now()
      where p.id = r.id
      returning p.* into r;
    end if;

    return query
    select r.id, r.reg_no, r.full_name, r.queue_status, v_already;
    return;
  end if;

  if r.queue_status = 'waiting' then
    if r.printed_at is null or r.queued_at is null or r.checked_in_by is null then
      update public.patients p
      set printed_at = coalesce(p.printed_at, now()),
          queued_at = coalesce(p.queued_at, now()),
          checked_in_by = coalesce(p.checked_in_by, (select auth.uid()))
      where p.id = r.id
      returning p.* into r;
    end if;

    return query
    select r.id, r.reg_no, r.full_name, r.queue_status, v_already;
    return;
  end if;

  if r.queue_status is distinct from 'registered' then
    raise exception 'Unsupported patient queue status';
  end if;

  update public.patients p
  set queue_status = 'waiting',
      queued_at = coalesce(p.queued_at, now()),
      printed_at = coalesce(p.printed_at, now()),
      checked_in_by = coalesce(p.checked_in_by, (select auth.uid()))
  where p.id = r.id
  returning p.* into r;

  return query
  select r.id, r.reg_no, r.full_name, r.queue_status, false;
end;
$$;


--
-- Name: register_patient(uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.register_patient(p_camp_id uuid, p_full_name text, p_gender text DEFAULT NULL::text, p_age integer DEFAULT NULL::integer, p_address text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_email text DEFAULT NULL::text, p_aadhaar_last4 text DEFAULT NULL::text, p_user_id uuid DEFAULT NULL::uuid, p_created_by uuid DEFAULT NULL::uuid, p_camp_day_id uuid DEFAULT NULL::uuid) RETURNS TABLE(id uuid, reg_no integer, full_name text, camp_day_id uuid, day_date date, claim_token text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  return query
  select
    r.id,
    r.reg_no,
    r.full_name,
    r.camp_day_id,
    r.day_date,
    null::text as claim_token
  from public.register_patient_idempotent(
    p_request_id => gen_random_uuid(),
    p_camp_id => p_camp_id,
    p_full_name => p_full_name,
    p_gender => p_gender,
    p_age => p_age,
    p_address => p_address,
    p_phone => p_phone,
    p_email => p_email,
    p_aadhaar_last4 => p_aadhaar_last4,
    p_user_id => p_user_id,
    p_created_by => p_created_by,
    p_camp_day_id => p_camp_day_id
  ) r;
end;
$$;


--
-- Name: register_patient_authorized_impl(uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.register_patient_idempotent(p_request_id uuid, p_camp_id uuid, p_full_name text, p_gender text DEFAULT NULL::text, p_age integer DEFAULT NULL::integer, p_address text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_email text DEFAULT NULL::text, p_aadhaar_last4 text DEFAULT NULL::text, p_user_id uuid DEFAULT NULL::uuid, p_created_by uuid DEFAULT NULL::uuid, p_camp_day_id uuid DEFAULT NULL::uuid) RETURNS TABLE(id uuid, reg_no integer, full_name text, camp_day_id uuid, day_date date)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  v_request_role text;
  v_user_id uuid;
  v_created_by uuid;
  v_aadhaar char(4);
  v_name text;
  v_phone10 text;
  v_existing_reg integer;
  v_day public.camp_days%rowtype;
  v_taken integer;
  v_row public.patients%rowtype;
begin
  if p_request_id is null then
    raise exception 'registration request id required';
  end if;

  v_request_role := coalesce(
    nullif(auth.role(), ''),
    nullif(current_setting('request.jwt.claim.role', true), '')
  );

  if v_request_role = 'service_role' then
    v_user_id := p_user_id;
    v_created_by := case when p_user_id is null then p_created_by else null end;
  elsif v_request_role = 'authenticated' then
    if not exists (
      select 1
      from public.profiles p
      where p.id = (select auth.uid())
        and p.role in ('admin', 'volunteer')
        and p.disabled_at is null
    ) then
      raise exception 'active admin or volunteer required';
    end if;
    v_user_id := null;
    v_created_by := (select auth.uid());
  else
    raise exception 'authenticated registration required';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('register-request:' || p_request_id::text)
  );

  select p.id, p.reg_no, p.full_name, p.camp_day_id, d.day_date
  into id, reg_no, full_name, camp_day_id, day_date
  from public.patients p
  join public.camp_days d on d.id = p.camp_day_id
  where p.registration_request_id = p_request_id;

  if found then
    return next;
    return;
  end if;

  v_name := trim(coalesce(p_full_name, ''));
  if length(v_name) = 0 or length(v_name) > 120 then
    raise exception 'full_name required and must be at most 120 characters';
  end if;
  if p_age is not null and (p_age < 0 or p_age >= 150) then
    raise exception 'age must be between 0 and 149';
  end if;

  if not exists (
    select 1
    from public.camps c
    where c.id = p_camp_id and c.is_active
  ) then
    raise exception 'No active camp';
  end if;

  if p_camp_day_id is null then
    raise exception 'Please select a camp day';
  end if;

  if v_user_id is not null then
    perform pg_advisory_xact_lock(
      hashtext('register-user:' || p_camp_id::text || ':' || v_user_id::text)
    );

    select p.reg_no
    into v_existing_reg
    from public.patients p
    where p.camp_id = p_camp_id
      and p.user_id = v_user_id
    limit 1;

    if v_existing_reg is not null then
      raise exception
        'Already registered for this camp (reg no %). Change day instead.',
        v_existing_reg;
    end if;
  end if;

  select *
  into v_day
  from public.camp_days d
  where d.id = p_camp_day_id
  for update;

  if v_day.id is null or v_day.camp_id is distinct from p_camp_id then
    raise exception 'Invalid camp day';
  end if;

  select count(*)::integer
  into v_taken
  from public.patients p
  where p.camp_day_id = p_camp_day_id;

  if v_taken >= v_day.seat_limit then
    raise exception 'This day is full (% seats). Choose another day.', v_day.seat_limit;
  end if;

  if p_aadhaar_last4 is null or length(trim(p_aadhaar_last4)) = 0 then
    v_aadhaar := null;
  else
    v_aadhaar := right(regexp_replace(p_aadhaar_last4, '\D', '', 'g'), 4);
    if v_aadhaar !~ '^[0-9]{4}$' then
      raise exception 'Invalid aadhaar last4';
    end if;
  end if;

  v_phone10 := nullif(
    right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10),
    ''
  );
  if v_phone10 is not null and length(v_phone10) < 10 then
    v_phone10 := null;
  end if;

  insert into public.patients (
    registration_request_id,
    camp_id,
    camp_day_id,
    user_id,
    full_name,
    gender,
    age,
    address,
    phone,
    email,
    aadhaar_last4,
    created_by,
    queue_status,
    queued_at
  )
  values (
    p_request_id,
    p_camp_id,
    p_camp_day_id,
    v_user_id,
    v_name,
    case when p_gender in ('M', 'F', 'O') then p_gender else null end,
    p_age,
    nullif(trim(coalesce(p_address, '')), ''),
    v_phone10,
    nullif(trim(coalesce(p_email, '')), ''),
    v_aadhaar,
    v_created_by,
    'registered',
    null
  )
  returning public.patients.* into v_row;

  id := v_row.id;
  reg_no := v_row.reg_no;
  full_name := v_row.full_name;
  camp_day_id := v_row.camp_day_id;
  day_date := v_day.day_date;
  return next;
end;
$$;


CREATE FUNCTION public.app_database_contract() RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select case
    when to_regprocedure(
      'public.register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid)'
    ) is not null
      and to_regprocedure('public.doctor_recent_patients(uuid,integer)') is not null
      and to_regprocedure('public.link_patient_phone(text)') is not null
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
          and a.attname = 'account_provisioning_token'
          and a.attnum > 0
          and not a.attisdropped
      )
    then '20260722050000'
    else 'incomplete'
  end;
$$;


--
-- Name: set_active_camp(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_active_camp(p_camp_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not public.is_admin() then
    raise exception 'admin only';
  end if;
  if not exists (select 1 from public.camps where id = p_camp_id) then
    raise exception 'Camp not found';
  end if;
  update public.camps set is_active = false where is_active = true;
  update public.camps set is_active = true where id = p_camp_id;
end;
$$;


--
-- Name: staff_person_kpis(uuid, text, uuid, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.staff_person_kpis(p_user_id uuid, p_role text, p_camp_id uuid DEFAULT NULL::uuid, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS TABLE(total bigint, today bigint, waiting bigint, seen bigint, label text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
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
    return query
    select
      count(*)::bigint,
      count(*) filter (where p.seen_at >= v_since)::bigint,
      0::bigint,
      count(*)::bigint,
      'Patients seen'::text
    from public.patients p
    where p.seen_by = p_user_id
      and p.queue_status = 'seen'
      and (p_camp_id is null or p.camp_id = p_camp_id);
  elsif p_role = 'volunteer' then
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
      'Patients handled'::text
    from public.patients p
    where (p.created_by = p_user_id or p.checked_in_by = p_user_id)
      and (p_camp_id is null or p.camp_id = p_camp_id);
  else
    raise exception 'invalid role';
  end if;
end;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: camp_days; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.camp_days (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    camp_id uuid NOT NULL,
    day_date date NOT NULL,
    seat_limit integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT camp_days_seat_limit_check CHECK ((seat_limit >= 0))
);


--
-- Name: upsert_camp_day(uuid, date, integer, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.upsert_camp_day(p_camp_id uuid, p_day_date date, p_seat_limit integer, p_day_id uuid DEFAULT NULL::uuid) RETURNS public.camp_days
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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

  if p_day_id is not null then
    select d.* into r
    from public.camp_days d
    where d.id = p_day_id and d.camp_id = p_camp_id
    for update;
    if r.id is null then
      raise exception 'Day not found';
    end if;

    select count(*)::int into v_taken
    from public.patients p
    where p.camp_day_id = r.id;
    if p_seat_limit < v_taken then
      raise exception 'Cannot set seats below taken (%)', v_taken;
    end if;

    update public.camp_days d
    set day_date = p_day_date,
        seat_limit = p_seat_limit
    where d.id = r.id
    returning d.* into r;
    return r;
  end if;

  insert into public.camp_days (camp_id, day_date, seat_limit)
  values (p_camp_id, p_day_date, p_seat_limit)
  on conflict (camp_id, day_date)
  do update set seat_limit = excluded.seat_limit
  returning * into r;

  select count(*)::int into v_taken
  from public.patients p
  where p.camp_day_id = r.id;
  if r.seat_limit < v_taken then
    raise exception 'Cannot set seats below taken (%)', v_taken;
  end if;

  return r;
end;
$$;


--
-- Name: volunteer_my_counts(timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.volunteer_my_counts(p_since timestamp with time zone) RETURNS TABLE(total bigint, today bigint, waiting bigint, seen bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select
    count(*)::bigint,
    count(*) filter (
      where (p.created_by = (select auth.uid()) and p.created_at >= p_since)
        or (
          p.checked_in_by = (select auth.uid())
          and coalesce(p.queued_at, p.seen_at, p.created_at) >= p_since
        )
    )::bigint,
    count(*) filter (where p.queue_status = 'waiting')::bigint,
    count(*) filter (where p.queue_status = 'seen')::bigint
  from public.patients p
  where (p.created_by = (select auth.uid()) or p.checked_in_by = (select auth.uid()))
    and (
      not exists (select 1 from public.camps c where c.is_active)
      or p.camp_id = (
        select c.id
        from public.camps c
        where c.is_active
        limit 1
      )
    )
    and exists (
      select 1
      from public.profiles pr
      where pr.id = (select auth.uid())
        and pr.role in ('admin', 'volunteer')
        and pr.disabled_at is null
    );
$$;


--
-- Name: camps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.camps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    venue text,
    camp_date date,
    is_active boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: patient_reg_no_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.patient_reg_no_seq
    START WITH 1000
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: patients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    camp_id uuid NOT NULL,
    reg_no integer DEFAULT nextval('public.patient_reg_no_seq'::regclass) NOT NULL,
    full_name text NOT NULL,
    gender text,
    age integer,
    address text,
    phone text,
    email text,
    aadhaar_last4 character(4),
    queue_status public.queue_status DEFAULT 'registered'::public.queue_status NOT NULL,
    queued_at timestamp with time zone,
    printed_at timestamp with time zone,
    seen_at timestamp with time zone,
    seen_by uuid,
    checked_in_by uuid,
    created_by uuid,
    registration_request_id uuid,
    account_provisioning_token text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    camp_day_id uuid,
    phone_normalized text GENERATED ALWAYS AS (NULLIF("right"(regexp_replace(COALESCE(phone, ''::text), '\D'::text, ''::text, 'g'::text), 10), ''::text)) STORED,
    full_name_normalized text GENERATED ALWAYS AS (lower(btrim(full_name))) STORED,
    CONSTRAINT patients_aadhaar_last4_check CHECK (((aadhaar_last4 IS NULL) OR (aadhaar_last4 ~ '^[0-9]{4}$'::text))),
    CONSTRAINT patients_age_check CHECK (((age IS NULL) OR ((age >= 0) AND (age < 150)))),
    CONSTRAINT patients_gender_check CHECK (((gender = ANY (ARRAY['M'::text, 'F'::text, 'O'::text])) OR (gender IS NULL)))
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    role public.user_role DEFAULT 'patient'::public.user_role NOT NULL,
    full_name text,
    phone text,
    email text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    disabled_at timestamp with time zone
);


--
-- Name: camp_days camp_days_camp_id_day_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.camp_days
    ADD CONSTRAINT camp_days_camp_id_day_date_key UNIQUE (camp_id, day_date);


--
-- Name: camp_days camp_days_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.camp_days
    ADD CONSTRAINT camp_days_pkey PRIMARY KEY (id);


--
-- Name: camps camps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.camps
    ADD CONSTRAINT camps_pkey PRIMARY KEY (id);


--
-- Name: patients patients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patients
    ADD CONSTRAINT patients_pkey PRIMARY KEY (id);


--
-- Name: patients patients_reg_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patients
    ADD CONSTRAINT patients_reg_no_key UNIQUE (reg_no);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: camp_days_camp_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX camp_days_camp_date_idx ON public.camp_days USING btree (camp_id, day_date);


--
-- Name: camps_one_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX camps_one_active ON public.camps USING btree (is_active) WHERE (is_active = true);


--
-- Name: patients_registration_request_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX patients_registration_request_id_idx ON public.patients USING btree (registration_request_id) WHERE (registration_request_id IS NOT NULL);


--
-- Name: patients_account_provisioning_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX patients_account_provisioning_token_idx ON public.patients USING btree (account_provisioning_token) WHERE (account_provisioning_token IS NOT NULL);


--
-- Name: patients_camp_aadhaar_name_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX patients_camp_aadhaar_name_unique_idx ON public.patients USING btree (camp_id, aadhaar_last4, full_name_normalized) WHERE (aadhaar_last4 IS NOT NULL);


--
-- Name: patients_camp_day_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patients_camp_day_id_idx ON public.patients USING btree (camp_day_id) WHERE (camp_day_id IS NOT NULL);


--
-- Name: patients_camp_day_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patients_camp_day_idx ON public.patients USING btree (camp_day_id);


--
-- Name: patients_camp_queue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patients_camp_queue_idx ON public.patients USING btree (camp_id, queue_status, created_at);


--
-- Name: patients_camp_user_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX patients_camp_user_unique_idx ON public.patients USING btree (camp_id, user_id) WHERE (user_id IS NOT NULL);


--
-- Name: patients_camp_waiting_queued_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patients_camp_waiting_queued_idx ON public.patients USING btree (camp_id, queued_at, created_at) WHERE (queue_status = 'waiting'::public.queue_status);


--
-- Name: patients_checked_in_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patients_checked_in_by_idx ON public.patients USING btree (checked_in_by) WHERE (checked_in_by IS NOT NULL);


--
-- Name: patients_created_by_created_at_idx; Type: INDEX; Schema: public; Owner: -
--


CREATE INDEX patients_created_by_created_at_idx ON public.patients USING btree (created_by, created_at) WHERE (created_by IS NOT NULL);


--
-- Name: patients_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patients_created_by_idx ON public.patients USING btree (created_by) WHERE (created_by IS NOT NULL);


--
-- Name: patients_full_name_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patients_full_name_trgm_idx ON public.patients USING gin (full_name_normalized extensions.gin_trgm_ops);


--
-- Name: patients_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patients_name_idx ON public.patients USING btree (full_name);


--
-- Name: patients_phone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patients_phone_idx ON public.patients USING btree (phone);


--
-- Name: patients_seen_by_camp_seen_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patients_seen_by_camp_seen_at_idx ON public.patients USING btree (camp_id, seen_by, seen_at DESC) WHERE ((queue_status = 'seen'::public.queue_status) AND (seen_by IS NOT NULL));


--
-- Name: patients_seen_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patients_seen_by_idx ON public.patients USING btree (seen_by) WHERE (seen_by IS NOT NULL);


--
-- Name: patients_seen_by_seen_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patients_seen_by_seen_at_idx ON public.patients USING btree (seen_by, seen_at) WHERE (seen_by IS NOT NULL);


--
-- Name: patients_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patients_user_id_idx ON public.patients USING btree (user_id) WHERE (user_id IS NOT NULL);


--
-- Name: camp_days camp_days_camp_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.camp_days
    ADD CONSTRAINT camp_days_camp_id_fkey FOREIGN KEY (camp_id) REFERENCES public.camps(id) ON DELETE CASCADE;


--
-- Name: patients patients_camp_day_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patients
    ADD CONSTRAINT patients_camp_day_id_fkey FOREIGN KEY (camp_day_id) REFERENCES public.camp_days(id) ON DELETE RESTRICT;


--
-- Name: patients patients_camp_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patients
    ADD CONSTRAINT patients_camp_id_fkey FOREIGN KEY (camp_id) REFERENCES public.camps(id) ON DELETE RESTRICT;


--
-- Name: patients patients_checked_in_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patients
    ADD CONSTRAINT patients_checked_in_by_fkey FOREIGN KEY (checked_in_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: patients patients_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patients
    ADD CONSTRAINT patients_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: patients patients_created_by_profiles_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patients
    ADD CONSTRAINT patients_created_by_profiles_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: patients patients_seen_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patients
    ADD CONSTRAINT patients_seen_by_fkey FOREIGN KEY (seen_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: patients patients_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patients
    ADD CONSTRAINT patients_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: camp_days admin delete camp days; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin delete camp days" ON public.camp_days FOR DELETE TO authenticated USING (( SELECT public.is_admin() AS is_admin));


--
-- Name: camps admin delete camps; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin delete camps" ON public.camps FOR DELETE TO authenticated USING (( SELECT public.is_admin() AS is_admin));


--
-- Name: patients admin delete patients; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin delete patients" ON public.patients FOR DELETE TO authenticated USING (( SELECT public.is_admin() AS is_admin));


--
-- Name: camp_days admin insert camp days; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin insert camp days" ON public.camp_days FOR INSERT TO authenticated WITH CHECK (( SELECT public.is_admin() AS is_admin));


--
-- Name: camps admin insert camps; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin insert camps" ON public.camps FOR INSERT TO authenticated WITH CHECK (( SELECT public.is_admin() AS is_admin));


--
-- Name: camp_days admin update camp days; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin update camp days" ON public.camp_days FOR UPDATE TO authenticated USING (( SELECT public.is_admin() AS is_admin)) WITH CHECK (( SELECT public.is_admin() AS is_admin));


--
-- Name: camps admin update camps; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admin update camps" ON public.camps FOR UPDATE TO authenticated USING (( SELECT public.is_admin() AS is_admin)) WITH CHECK (( SELECT public.is_admin() AS is_admin));


--
-- Name: camps anon read active camp; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "anon read active camp" ON public.camps FOR SELECT TO anon USING ((is_active = true));


--
-- Name: camp_days anon read camp days; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "anon read camp days" ON public.camp_days FOR SELECT TO anon USING (true);


--
-- Name: camp_days authenticated read camp days; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "authenticated read camp days" ON public.camp_days FOR SELECT TO authenticated USING (true);


--
-- Name: camps authenticated read camps; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "authenticated read camps" ON public.camps FOR SELECT TO authenticated USING (true);


--
-- Name: patients authenticated read permitted patients; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "authenticated read permitted patients" ON public.patients FOR SELECT TO authenticated USING (((user_id = ( SELECT auth.uid() AS uid)) OR ( SELECT public.is_admin() AS is_admin) OR (( SELECT public.is_staff() AS is_staff) AND (NOT ( SELECT public.is_admin() AS is_admin)) AND (NOT ( SELECT public.is_doctor() AS is_doctor)) AND (EXISTS ( SELECT 1
   FROM public.camps c
  WHERE ((c.id = patients.camp_id) AND c.is_active))))));


--
-- Name: profiles authenticated read permitted profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "authenticated read permitted profiles" ON public.profiles FOR SELECT TO authenticated USING (((id = ( SELECT auth.uid() AS uid)) OR ( SELECT public.is_admin() AS is_admin)));


--
-- Name: camp_days; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.camp_days ENABLE ROW LEVEL SECURITY;

--
-- Name: camps; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.camps ENABLE ROW LEVEL SECURITY;

--
-- Name: patients; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Supabase projects ship permissive default privileges for PostgREST roles.
-- Reset inherited object grants before replaying the explicit ACLs below so a
-- fresh install has the same least-privilege state as the migrated database.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public
  FROM PUBLIC, anon, authenticated, service_role;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION active_camp_snapshot(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.active_camp_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.active_camp_snapshot() TO anon, authenticated, service_role, postgres;


--
-- Name: FUNCTION assign_patient_doctor(p_patient_id uuid, p_reg_no integer, p_doctor_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.assign_patient_doctor(p_patient_id uuid, p_reg_no integer, p_doctor_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_patient_doctor(p_patient_id uuid, p_reg_no integer, p_doctor_id uuid) TO authenticated, service_role, postgres;


--
-- Name: FUNCTION camp_day_stats(p_camp_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.camp_day_stats(p_camp_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.camp_day_stats(p_camp_id uuid) TO authenticated, service_role, postgres;


--
-- Name: FUNCTION camp_queue_counts(p_camp_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.camp_queue_counts(p_camp_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.camp_queue_counts(p_camp_id uuid) TO authenticated, service_role, postgres;


--
-- Name: FUNCTION change_camp_day(p_patient_id uuid, p_new_day_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.change_camp_day(p_patient_id uuid, p_new_day_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.change_camp_day(p_patient_id uuid, p_new_day_id uuid) TO authenticated, service_role, postgres;


--
-- Name: FUNCTION delete_camp(p_camp_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.delete_camp(p_camp_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_camp(p_camp_id uuid) TO authenticated, service_role, postgres;


--
-- Name: FUNCTION delete_camp_day(p_day_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.delete_camp_day(p_day_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_camp_day(p_day_id uuid) TO authenticated, service_role, postgres;


--
-- Name: FUNCTION doctor_my_counts(p_camp_id uuid, p_since timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.doctor_my_counts(p_camp_id uuid, p_since timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.doctor_my_counts(p_camp_id uuid, p_since timestamp with time zone) TO authenticated, service_role, postgres;


--
-- Name: FUNCTION doctor_recent_patients(p_camp_id uuid, p_limit integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.doctor_recent_patients(p_camp_id uuid, p_limit integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.doctor_recent_patients(p_camp_id uuid, p_limit integer) TO authenticated, service_role, postgres;


--
-- Name: FUNCTION handle_new_user(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO postgres, service_role;


--
-- Name: FUNCTION is_admin(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role, postgres;


--
-- Name: FUNCTION is_doctor(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.is_doctor() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_doctor() TO authenticated, service_role, postgres;


--
-- Name: FUNCTION is_staff(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.is_staff() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_staff() TO authenticated, service_role, postgres;


--
-- Name: FUNCTION link_patient_phone(p_phone text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.link_patient_phone(p_phone text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_patient_phone(p_phone text) TO authenticated, service_role, postgres;


--
-- Name: FUNCTION lookup_patient_scan(p_patient_id uuid, p_reg_no integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.lookup_patient_scan(p_patient_id uuid, p_reg_no integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lookup_patient_scan(p_patient_id uuid, p_reg_no integer) TO authenticated, service_role, postgres;


--
-- Name: FUNCTION mark_patient_printed(p_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.mark_patient_printed(p_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_patient_printed(p_id uuid) TO authenticated, service_role, postgres;


--
-- Name: FUNCTION register_patient_idempotent(p_request_id uuid, p_camp_id uuid, p_full_name text, p_gender text, p_age integer, p_address text, p_phone text, p_email text, p_aadhaar_last4 text, p_user_id uuid, p_created_by uuid, p_camp_day_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.register_patient_idempotent(p_request_id uuid, p_camp_id uuid, p_full_name text, p_gender text, p_age integer, p_address text, p_phone text, p_email text, p_aadhaar_last4 text, p_user_id uuid, p_created_by uuid, p_camp_day_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_patient_idempotent(p_request_id uuid, p_camp_id uuid, p_full_name text, p_gender text, p_age integer, p_address text, p_phone text, p_email text, p_aadhaar_last4 text, p_user_id uuid, p_created_by uuid, p_camp_day_id uuid) TO authenticated, service_role, postgres;


--
-- Name: FUNCTION register_patient(p_camp_id uuid, p_full_name text, p_gender text, p_age integer, p_address text, p_phone text, p_email text, p_aadhaar_last4 text, p_user_id uuid, p_created_by uuid, p_camp_day_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.register_patient(p_camp_id uuid, p_full_name text, p_gender text, p_age integer, p_address text, p_phone text, p_email text, p_aadhaar_last4 text, p_user_id uuid, p_created_by uuid, p_camp_day_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_patient(p_camp_id uuid, p_full_name text, p_gender text, p_age integer, p_address text, p_phone text, p_email text, p_aadhaar_last4 text, p_user_id uuid, p_created_by uuid, p_camp_day_id uuid) TO authenticated, service_role, postgres;


--
-- Name: FUNCTION set_active_camp(p_camp_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.set_active_camp(p_camp_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_active_camp(p_camp_id uuid) TO authenticated, service_role, postgres;


--
-- Name: FUNCTION staff_person_kpis(p_user_id uuid, p_role text, p_camp_id uuid, p_since timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.staff_person_kpis(p_user_id uuid, p_role text, p_camp_id uuid, p_since timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_person_kpis(p_user_id uuid, p_role text, p_camp_id uuid, p_since timestamp with time zone) TO authenticated, service_role, postgres;


--
-- Name: FUNCTION upsert_camp_day(p_camp_id uuid, p_day_date date, p_seat_limit integer, p_day_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.upsert_camp_day(p_camp_id uuid, p_day_date date, p_seat_limit integer, p_day_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_camp_day(p_camp_id uuid, p_day_date date, p_seat_limit integer, p_day_id uuid) TO authenticated, service_role, postgres;


--
-- Name: FUNCTION volunteer_my_counts(p_since timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.volunteer_my_counts(p_since timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.volunteer_my_counts(p_since timestamp with time zone) TO authenticated, service_role, postgres;


--
-- Name: TABLE camps; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.camps TO postgres;
GRANT ALL ON TABLE public.camps TO service_role;
GRANT SELECT ON TABLE public.camps TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.camps TO authenticated;


--
-- Name: SEQUENCE patient_reg_no_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.patient_reg_no_seq TO postgres;
GRANT ALL ON SEQUENCE public.patient_reg_no_seq TO service_role;


--
-- Name: TABLE patients; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.patients TO postgres;
GRANT ALL ON TABLE public.patients TO service_role;
GRANT DELETE ON TABLE public.patients TO authenticated;


--
-- Name: COLUMN patients.id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(id) ON TABLE public.patients TO authenticated;


--
-- Name: COLUMN patients.user_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(user_id) ON TABLE public.patients TO authenticated;


--
-- Name: COLUMN patients.camp_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(camp_id) ON TABLE public.patients TO authenticated;


--
-- Name: COLUMN patients.reg_no; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(reg_no) ON TABLE public.patients TO authenticated;


--
-- Name: COLUMN patients.full_name; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(full_name) ON TABLE public.patients TO authenticated;


--
-- Name: COLUMN patients.gender; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(gender) ON TABLE public.patients TO authenticated;


--
-- Name: COLUMN patients.age; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(age) ON TABLE public.patients TO authenticated;


--
-- Name: COLUMN patients.address; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(address) ON TABLE public.patients TO authenticated;


--
-- Name: COLUMN patients.phone; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(phone) ON TABLE public.patients TO authenticated;


--
-- Name: COLUMN patients.email; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(email) ON TABLE public.patients TO authenticated;


--
-- Name: COLUMN patients.aadhaar_last4; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(aadhaar_last4) ON TABLE public.patients TO authenticated;


--
-- Name: COLUMN patients.queue_status; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(queue_status) ON TABLE public.patients TO authenticated;


--
-- Name: COLUMN patients.queued_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(queued_at) ON TABLE public.patients TO authenticated;


--
-- Name: COLUMN patients.printed_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(printed_at) ON TABLE public.patients TO authenticated;


--
-- Name: COLUMN patients.seen_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(seen_at) ON TABLE public.patients TO authenticated;


--
-- Name: COLUMN patients.seen_by; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(seen_by) ON TABLE public.patients TO authenticated;


--
-- Name: COLUMN patients.checked_in_by; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(checked_in_by) ON TABLE public.patients TO authenticated;


--
-- Name: COLUMN patients.created_by; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(created_by) ON TABLE public.patients TO authenticated;


--
-- Name: COLUMN patients.created_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(created_at) ON TABLE public.patients TO authenticated;


--
-- Name: COLUMN patients.camp_day_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(camp_day_id) ON TABLE public.patients TO authenticated;


--
-- Name: COLUMN patients.phone_normalized; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(phone_normalized) ON TABLE public.patients TO authenticated;


--
-- Name: COLUMN patients.full_name_normalized; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(full_name_normalized) ON TABLE public.patients TO authenticated;


--
-- Name: TABLE profiles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.profiles TO postgres;
GRANT SELECT ON TABLE public.profiles TO authenticated;
GRANT ALL ON TABLE public.profiles TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;


--
-- Name: CONDITIONAL DEFAULT PRIVILEGES FOR supabase_admin; Type: DEFAULT ACL; Schema: public; Owner: -
--

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    IF current_user = 'supabase_admin'
      OR pg_has_role(current_user, 'supabase_admin', 'MEMBER')
    THEN
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres';
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role';
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated';
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres';
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role';
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated';
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC';
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO postgres';
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO service_role';
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated';
    END IF;
  END IF;
END;
$$;


--
-- PostgreSQL database dump complete
--

-- Supabase Auth owns auth.users, so its profile trigger is outside the public
-- schema dump and must be installed explicitly.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

NOTIFY pgrst, 'reload schema';
