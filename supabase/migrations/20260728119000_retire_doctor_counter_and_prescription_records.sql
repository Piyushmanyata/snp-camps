-- Retire the doctor station, the counter desk and the digital prescription record.
--
-- The camp's paper prescription is now the clinical record (D13/D16). The app's
-- entire job is registered -> waiting -> seen. Printing the prescription is what
-- puts a patient in the queue; a volunteer or team lead later marks them seen.
--
-- Irreversible by design (D14): production holds test data only, confirmed by
-- the owner before this migration was authored. There is no down path.
--
-- Append-only; must replay clean on a disposable database (#68).

begin;

-- ---------------------------------------------------------------------------
-- 1. Functions that read or write the retired records.
-- ---------------------------------------------------------------------------

drop function if exists public.add_prescription_amendment(uuid, text);
drop function if exists public.admin_list_deferred_orders(uuid, text);
drop function if exists public.assign_patient_doctor(uuid, integer, uuid);
drop function if exists public.assign_patient_doctor_registration_impl(uuid, integer, uuid);
drop function if exists public.counter_create_and_fulfill_order(uuid, text[]);
drop function if exists public.doctor_my_counts(uuid, timestamptz);
drop function if exists public.doctor_recent_patients(uuid, integer);
drop function if exists public.doctor_submit_prescription(uuid, text, text, text, text, text, text[]);
drop function if exists public.resolve_treatment_order(uuid, text, date, text);

-- ---------------------------------------------------------------------------
-- 2. The records themselves. Cascade takes their RLS policies, the
--    treatment_orders attribution trigger and its function with them.
-- ---------------------------------------------------------------------------

drop table if exists public.prescription_amendments cascade;
drop table if exists public.treatment_orders cascade;
drop table if exists public.prescriptions cascade;

drop function if exists public.set_treatment_order_attribution();

-- ---------------------------------------------------------------------------
-- 3. Theatre capacity. Only the OT scheduler read it.
--    upsert_camp_day loses a parameter, so the old signature must be dropped
--    explicitly — a narrower CREATE would fork the function and strand grants.
-- ---------------------------------------------------------------------------

alter table public.camp_days drop column if exists theatre_capacity;

drop function if exists public.upsert_camp_day(uuid, date, integer, uuid, integer);

-- Body preserved from the 5-arg version minus theatre capacity. The FOR UPDATE
-- lock order and the SEAT_LIMIT_BELOW_ASSIGNED guard are the whole point of #66:
-- they serialize a capacity edit against concurrent registrations.
create function public.upsert_camp_day(
  p_camp_id uuid,
  p_day_date date,
  p_seat_limit integer,
  p_day_id uuid default null
)
returns public.camp_days
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
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

comment on function public.upsert_camp_day(uuid, date, integer, uuid) is
  'Admin upsert of camp day seat_limit. Lock order: camp_days FOR UPDATE, then count assigned patients, then update or SEAT_LIMIT_BELOW_ASSIGNED.';

alter function public.upsert_camp_day(uuid, date, integer, uuid) owner to postgres;
revoke all on function public.upsert_camp_day(uuid, date, integer, uuid) from public, anon;
grant execute on function public.upsert_camp_day(uuid, date, integer, uuid)
  to authenticated, service_role, postgres;

-- ---------------------------------------------------------------------------
-- 4. Role collapse (D21). `doctor` holds no login role, so camp crew and staff
--    are the same set. The enum value stays — Postgres cannot drop one, and the
--    app already treats `doctor` and `patient` as non-login roles.
-- ---------------------------------------------------------------------------

create or replace function public.is_camp_crew()
returns boolean
language sql
stable security definer
set search_path to 'pg_catalog', 'public'
as $function$
  select public.is_staff();
$function$;

drop function if exists public.is_doctor();

-- Any residual doctor profile loses its session; it can no longer reach a desk.
update public.profiles
set disabled_at = coalesce(disabled_at, now())
where role = 'doctor'::public.user_role;

-- ---------------------------------------------------------------------------
-- 5. Scan lookup. 22 columns of prescription, theatre and OT scheduling state
--    collapse to the six the two-button desk actually reads.
-- ---------------------------------------------------------------------------

drop function if exists public.lookup_patient_scan(uuid, integer);
drop function if exists public.lookup_patient_scan_registration_impl(uuid, integer);

create function public.lookup_patient_scan_registration_impl(
  p_patient_id uuid default null,
  p_reg_no integer default null
)
returns table(
  id uuid,
  reg_no integer,
  full_name text,
  queue_status public.queue_status,
  phone text,
  seen_at timestamptz,
  seen_by_name text,
  printed_at timestamptz
)
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
#variable_conflict use_column
declare
  r public.patients%rowtype;
  v_seen_by_name text;
begin
  if not public.is_camp_crew() then
    raise exception 'active camp crew only';
  end if;

  if p_patient_id is not null then
    select * into r from public.patients p where p.id = p_patient_id;
  elsif p_reg_no is not null then
    select * into r from public.patients p where p.reg_no = p_reg_no;
  else
    raise exception 'Provide patient id or reg no';
  end if;

  if r.id is null then
    raise exception 'Patient not found';
  end if;

  if not exists (
    select 1 from public.camps c where c.id = r.camp_id and c.is_active
  ) then
    raise exception 'Patient belongs to an inactive camp';
  end if;

  if r.seen_by is not null then
    select p.full_name into v_seen_by_name
    from public.profiles p
    where p.id = r.seen_by;
  end if;

  return query
  select
    r.id,
    r.reg_no,
    r.full_name,
    r.queue_status,
    r.phone,
    r.seen_at,
    v_seen_by_name,
    r.printed_at;
end;
$function$;

create function public.lookup_patient_scan(
  p_patient_id uuid default null,
  p_reg_no integer default null
)
returns table(
  id uuid,
  reg_no integer,
  full_name text,
  queue_status public.queue_status,
  phone text,
  seen_at timestamptz,
  seen_by_name text,
  printed_at timestamptz
)
language sql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
  select *
  from public.lookup_patient_scan_registration_impl(
    public.active_registration_id(p_patient_id, p_reg_no),
    null
  )
$function$;

grant execute on function public.lookup_patient_scan(uuid, integer)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Check-in is now "printed the prescription" (D24). Behaviour is unchanged —
--    registered -> waiting, idempotent, seen is terminal, queue never reorders —
--    so a reprint keeps the patient's original place in line. Only the doctor
--    column in the result is renamed.
-- ---------------------------------------------------------------------------

drop function if exists public.check_in_patient(uuid, integer);
drop function if exists public.check_in_patient_registration_impl(uuid, integer);

create function public.check_in_patient_registration_impl(
  p_patient_id uuid default null,
  p_reg_no integer default null
)
returns table(
  id uuid,
  reg_no integer,
  full_name text,
  queue_status public.queue_status,
  already_waiting boolean,
  seen_by_name text,
  error_code text
)
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  r public.patients%rowtype;
  v_seen_by_name text;
begin
  if not public.is_staff() then
    raise exception 'staff only';
  end if;

  if p_patient_id is not null then
    select * into r from public.patients p where p.id = p_patient_id for update;
  elsif p_reg_no is not null then
    select * into r from public.patients p where p.reg_no = p_reg_no for update;
  else
    raise exception 'Provide patient id or reg no';
  end if;

  if r.id is null then
    raise exception 'Patient not found';
  end if;

  if not exists (
    select 1 from public.camps c where c.id = r.camp_id and c.is_active
  ) then
    raise exception 'Patient belongs to an inactive camp';
  end if;

  -- Seen is terminal. A reprint for an already-seen patient is allowed by the
  -- desk, but it must not drag them back into the queue.
  if r.queue_status = 'seen' then
    select p.full_name into v_seen_by_name
    from public.profiles p
    where p.id = r.seen_by;

    return query
    select r.id, r.reg_no, r.full_name, r.queue_status,
           false, coalesce(v_seen_by_name, 'Unknown'), 'already_seen'::text;
    return;
  end if;

  -- Idempotent: a reprint keeps the original queued_at, so no reorder (D24).
  if r.queue_status = 'waiting' then
    return query
    select r.id, r.reg_no, r.full_name, r.queue_status,
           true, null::text, null::text;
    return;
  end if;

  if r.queue_status is distinct from 'registered' then
    raise exception 'Unsupported patient queue status';
  end if;

  update public.patients p
  set queue_status = 'waiting',
      queued_at = now(),
      printed_at = coalesce(p.printed_at, now()),
      checked_in_by = coalesce(p.checked_in_by, (select auth.uid()))
  where p.id = r.id
  returning p.* into r;

  return query
  select r.id, r.reg_no, r.full_name, r.queue_status,
         false, null::text, null::text;
end;
$function$;

create function public.check_in_patient(
  p_patient_id uuid default null,
  p_reg_no integer default null
)
returns table(
  id uuid,
  reg_no integer,
  full_name text,
  queue_status public.queue_status,
  already_waiting boolean,
  seen_by_name text,
  error_code text
)
language sql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
  select *
  from public.check_in_patient_registration_impl(
    public.active_registration_id(p_patient_id, p_reg_no),
    null
  )
$function$;

grant execute on function public.check_in_patient(uuid, integer)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. mark_seen — the second of the two desk actions (D22).
--    Replaces assign_patient_doctor: no doctor is chosen, the volunteer who
--    scans is recorded in seen_by. Business rejections come back as error_code
--    rather than exceptions so the desk can name the reason (D25).
-- ---------------------------------------------------------------------------

create function public.mark_seen(
  p_patient_id uuid default null,
  p_reg_no integer default null
)
returns table(
  id uuid,
  reg_no integer,
  full_name text,
  queue_status public.queue_status,
  seen_at timestamptz,
  seen_by_name text,
  already_seen boolean,
  error_code text
)
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  r public.patients%rowtype;
  v_actor uuid := (select auth.uid());
  v_seen_by_name text;
begin
  if not public.is_staff() then
    raise exception 'staff only';
  end if;

  select * into r
  from public.patients p
  where p.id = public.active_registration_id(p_patient_id, p_reg_no)
  for update;

  if r.id is null then
    raise exception 'Patient not found';
  end if;

  if not exists (
    select 1 from public.camps c where c.id = r.camp_id and c.is_active
  ) then
    raise exception 'Patient belongs to an inactive camp';
  end if;

  -- Already seen: a successful, idempotent terminal outcome. Never re-stamp
  -- seen_at or reattribute seen_by — a double-scan must not rewrite history.
  if r.queue_status = 'seen' then
    select p.full_name into v_seen_by_name
    from public.profiles p
    where p.id = r.seen_by;

    return query
    select r.id, r.reg_no, r.full_name, r.queue_status,
           r.seen_at, v_seen_by_name, true, 'already_seen'::text;
    return;
  end if;

  -- Not in the queue yet: they were never printed for. Name the reason (D25).
  if r.queue_status = 'registered' then
    return query
    select r.id, r.reg_no, r.full_name, r.queue_status,
           null::timestamptz, null::text, false, 'not_in_queue'::text;
    return;
  end if;

  if r.queue_status is distinct from 'waiting' then
    raise exception 'Unsupported patient queue status';
  end if;

  update public.patients p
  set queue_status = 'seen',
      seen_at = now(),
      seen_by = v_actor
  where p.id = r.id
  returning p.* into r;

  select p.full_name into v_seen_by_name
  from public.profiles p
  where p.id = r.seen_by;

  return query
  select r.id, r.reg_no, r.full_name, r.queue_status,
         r.seen_at, v_seen_by_name, false, null::text;
end;
$function$;

grant execute on function public.mark_seen(uuid, integer)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. undo_mark_seen — a mis-scan is the likeliest desk error, and without this
--    the patient is stuck in a terminal state (D25). Time-limited so it cannot
--    be used to reopen yesterday's camp.
-- ---------------------------------------------------------------------------

create function public.undo_mark_seen(p_patient_id uuid)
returns table(
  id uuid,
  reg_no integer,
  full_name text,
  queue_status public.queue_status,
  error_code text
)
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  r public.patients%rowtype;
begin
  if not public.is_staff() then
    raise exception 'staff only';
  end if;

  select * into r from public.patients p where p.id = p_patient_id for update;

  if r.id is null then
    raise exception 'Patient not found';
  end if;

  if r.queue_status is distinct from 'seen' then
    return query
    select r.id, r.reg_no, r.full_name, r.queue_status, 'not_seen'::text;
    return;
  end if;

  if r.seen_at is null or r.seen_at < now() - interval '10 minutes' then
    return query
    select r.id, r.reg_no, r.full_name, r.queue_status, 'undo_window_expired'::text;
    return;
  end if;

  -- Back to the queue on their original queued_at, so undoing does not send the
  -- patient to the back of the line.
  update public.patients p
  set queue_status = 'waiting',
      seen_at = null,
      seen_by = null
  where p.id = r.id
  returning p.* into r;

  return query
  select r.id, r.reg_no, r.full_name, r.queue_status, null::text;
end;
$function$;

grant execute on function public.undo_mark_seen(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. Public status page. pending_orders described counter work that no longer
--    exists; the page now shows position only.
-- ---------------------------------------------------------------------------

drop function if exists public.patient_status_by_token(text);

create function public.patient_status_by_token(p_token text)
returns table(
  full_name text,
  reg_no integer,
  queue_status public.queue_status,
  queue_position integer,
  camp_name text,
  venue text,
  day_date date,
  patient_id uuid
)
language plpgsql
stable security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_token text;
  v_id uuid;
  v_camp_id uuid;
  v_full_name text;
  v_reg_no integer;
  v_status public.queue_status;
  v_camp_day_id uuid;
  v_position integer;
begin
  v_token := lower(btrim(coalesce(p_token, '')));
  if v_token = '' or v_token !~ '^[0-9a-f]{32}$' then
    return;
  end if;

  select
    p.id, p.camp_id, coalesce(p.display_name, p.full_name),
    p.reg_no, p.queue_status, p.camp_day_id
  into
    v_id, v_camp_id, v_full_name, v_reg_no, v_status, v_camp_day_id
  from public.patients p
  where p.status_token = v_token;

  if v_id is null then
    return;
  end if;

  full_name := v_full_name;
  reg_no := v_reg_no;
  queue_status := v_status;
  patient_id := v_id;

  if v_status = 'waiting'::public.queue_status then
    select ranked.pos::integer
    into v_position
    from (
      select
        peer.id,
        row_number() over (
          order by peer.queued_at asc nulls last, peer.reg_no asc, peer.id asc
        ) as pos
      from public.patients peer
      where peer.camp_id = v_camp_id
        and peer.queue_status = 'waiting'::public.queue_status
    ) ranked
    where ranked.id = v_id;

    queue_position := v_position;
  else
    queue_position := null;
  end if;

  select c.name, coalesce(c.venue, '—')
  into camp_name, venue
  from public.camps c
  where c.id = v_camp_id;

  if camp_name is null then
    camp_name := '—';
    venue := '—';
  end if;

  if v_camp_day_id is not null then
    select d.day_date into day_date
    from public.camp_days d
    where d.id = v_camp_day_id;
  else
    day_date := null;
  end if;

  return next;
end;
$function$;

-- service_role only, matching the pre-existing grant: the public status page
-- reaches this through the server, never from an anon browser session (#70).
grant execute on function public.patient_status_by_token(text) to service_role;

-- ---------------------------------------------------------------------------
-- 10. Per-camp prescription template (D15). Null means "use the built-in
--     default"; the admin editor writes header/footer/section overrides here.
-- ---------------------------------------------------------------------------

alter table public.camps
  add column if not exists prescription_template jsonb;

comment on column public.camps.prescription_template is
  'Per-camp prescription sheet overrides (header, footer, section labels, logo paths). Null uses the built-in template.';

-- ---------------------------------------------------------------------------
-- 11. Readiness catalog (#68). This must be rewritten in the same transaction:
--     it casts 'public.prescriptions'::regclass and calls has_table_privilege
--     on the dropped tables, both of which raise rather than return false once
--     the tables are gone. A stale probe would take readiness down entirely.
-- ---------------------------------------------------------------------------

create or replace function public.readiness_catalog_probe()
returns jsonb
language plpgsql
stable security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_tables jsonb;
  v_columns jsonb;
  v_functions jsonb;
  v_invariants jsonb;
  v_grants jsonb;
  v_states jsonb;
  v_kinds jsonb;
begin
  select jsonb_object_agg(expected.name, to_regclass('public.' || expected.name) is not null)
  into v_tables
  from (
    values
      ('patients'),
      ('persons'),
      ('camps'),
      ('camp_days'),
      ('profiles'),
      ('sms_deliveries'),
      ('public_rate_limit_buckets')
  ) as expected(name);

  select jsonb_object_agg(
    expected.table_name || '.' || expected.column_name,
    exists (
      select 1
      from information_schema.columns as c
      where c.table_schema = 'public'
        and c.table_name = expected.table_name
        and c.column_name = expected.column_name
    )
  )
  into v_columns
  from (
    values
      ('patients', 'id'),
      ('patients', 'status_token'),
      ('patients', 'queue_status'),
      ('patients', 'queued_at'),
      ('patients', 'printed_at'),
      ('patients', 'seen_at'),
      ('patients', 'seen_by'),
      ('patients', 'reg_no'),
      ('patients', 'camp_id'),
      ('patients', 'camp_day_id'),
      ('patients', 'full_name'),
      ('patients', 'display_name'),
      ('patients', 'person_id'),
      ('patients', 'provenance'),
      ('patients', 'phone_provenance'),
      ('persons', 'id'),
      ('persons', 'reg_no'),
      ('persons', 'full_name'),
      ('persons', 'display_name'),
      ('persons', 'gender'),
      ('persons', 'date_of_birth'),
      ('persons', 'aadhaar_last4'),
      ('persons', 'duplicate_key'),
      ('persons', 'aadhaar_locked_at'),
      ('persons', 'name_locked_at'),
      ('camps', 'id'),
      ('camps', 'name'),
      ('camps', 'is_active'),
      ('camps', 'venue'),
      ('camps', 'prescription_template'),
      ('camp_days', 'id'),
      ('camp_days', 'camp_id'),
      ('camp_days', 'day_date'),
      ('camp_days', 'seat_limit'),
      ('profiles', 'id'),
      ('profiles', 'role'),
      ('profiles', 'disabled_at'),
      ('profiles', 'team_lead_id'),
      ('sms_deliveries', 'id'),
      ('sms_deliveries', 'patient_id'),
      ('sms_deliveries', 'kind'),
      ('sms_deliveries', 'state'),
      ('sms_deliveries', 'claim_token'),
      ('sms_deliveries', 'phone_last4'),
      ('sms_deliveries', 'attempt_count'),
      ('sms_deliveries', 'dispatch_started_at'),
      ('sms_deliveries', 'updated_at'),
      ('public_rate_limit_buckets', 'scope'),
      ('public_rate_limit_buckets', 'key_hash'),
      ('public_rate_limit_buckets', 'window_started_at'),
      ('public_rate_limit_buckets', 'attempts'),
      ('public_rate_limit_buckets', 'expires_at')
  ) as expected(table_name, column_name);

  select jsonb_object_agg(
    expected.name,
    exists (
      select 1
      from pg_proc as p
      join pg_namespace as n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = expected.name
    )
  )
  into v_functions
  from (
    values
      ('latest_applied_migration'),
      ('readiness_catalog_probe'),
      ('patient_status_by_token'),
      ('upsert_camp_day'),
      ('register_patient_idempotent'),
      ('check_in_patient'),
      ('lookup_patient_scan'),
      ('mark_seen'),
      ('undo_mark_seen'),
      ('lookup_patient_status_token'),
      ('consume_public_rate_limit'),
      ('active_registration_id'),
      ('staff_person_kpis'),
      ('claim_sms_delivery'),
      ('mark_sms_dispatch_started'),
      ('complete_sms_delivery'),
      ('patient_registration_notify_fields')
  ) as expected(name);

  v_invariants := jsonb_build_object(
    'patients_camp_reg_no_unique',
      exists (
        select 1 from pg_constraint
        where conrelid = 'public.patients'::regclass
          and conname = 'patients_camp_reg_no_key'
          and contype = 'u'
          and convalidated
      ),
    'patients_person_camp_unique',
      exists (
        select 1 from pg_constraint
        where conrelid = 'public.patients'::regclass
          and conname = 'patients_person_camp_key'
          and contype = 'u'
          and convalidated
      ),
    'patients_person_id_not_null',
      exists (
        select 1
        from pg_attribute
        where attrelid = 'public.patients'::regclass
          and attname = 'person_id'
          and attnotnull
          and not attisdropped
      ),
    'patients_provenance_current',
      exists (
        select 1
        from pg_constraint
        where conrelid = 'public.patients'::regclass
          and conname = 'patients_provenance_check'
          and convalidated
          and pg_get_constraintdef(oid) like '%self_declared%'
          and pg_get_constraintdef(oid) like '%card_scanned%'
          and pg_get_constraintdef(oid) not like '%card_verified%'
          and pg_get_constraintdef(oid) not like '%ekyc_verified%'
      ),
    'retired_ekyc_storage_absent',
      not exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'patients'
          and column_name in ('aadhaar_hash', 'aadhaar_verified_at', 'aadhaar_kyc_ref')
      ),
    'register_rpc_supported_signatures_only',
      (
        select count(*) = 2
          and bool_and(
            pg_get_function_arguments(p.oid) not ilike '%aadhaar_hash%'
            and pg_get_function_arguments(p.oid) not ilike '%aadhaar_verified_at%'
            and pg_get_function_arguments(p.oid) not ilike '%aadhaar_kyc_ref%'
          )
        from pg_proc as p
        join pg_namespace as n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'register_patient_idempotent'
      ),
    'patients_phone_provenance_current',
      exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'patients'
          and column_name = 'phone_provenance'
          and is_nullable = 'NO'
          and column_default like '%self_declared%'
      )
      and exists (
        select 1
        from pg_constraint
        where conrelid = 'public.patients'::regclass
          and conname = 'patients_phone_provenance_check'
          and contype = 'c'
          and convalidated
          and pg_get_constraintdef(oid) like '%self_declared%'
      ),
    'staff_kpi_single_contract',
      (
        select count(*) = 1
          and bool_and(
            p.oid = to_regprocedure(
              'public.staff_person_kpis(uuid,text,uuid,timestamptz,text)'
            )
          )
        from pg_proc as p
        join pg_namespace as n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'staff_person_kpis'
      ),
    'staff_leaderboard_absent',
      to_regprocedure('public.staff_leaderboard(uuid,uuid)') is null,
    'migration_head_current',
      public.latest_applied_migration() = '20260728119000',
    'profiles_team_lead_fk',
      exists (
        select 1 from pg_constraint
        where conrelid = 'public.profiles'::regclass
          and conname = 'profiles_team_lead_id_fkey'
          and contype = 'f'
          and convalidated
      ),
    'team_membership_guards',
      (
        select count(*) = 2
          and bool_and(tgenabled <> 'D')
        from pg_trigger
        where tgrelid = 'public.profiles'::regclass
          and not tgisinternal
          and tgname in (
            'validate_profile_team_membership',
            'release_disabled_team_members'
          )
      ),
    -- The retired clinical record must stay retired. A table reappearing means
    -- an old migration was replayed over a newer database.
    'prescription_records_absent',
      to_regclass('public.prescriptions') is null
      and to_regclass('public.treatment_orders') is null
      and to_regclass('public.prescription_amendments') is null,
    'doctor_station_retired',
      to_regprocedure('public.assign_patient_doctor(uuid,integer,uuid)') is null
      and to_regprocedure('public.is_doctor()') is null
      and not exists (
        select 1
        from public.profiles
        where role = 'doctor'::public.user_role
          and disabled_at is null
      ),
    'mark_seen_contract',
      to_regprocedure('public.mark_seen(uuid,integer)') is not null
      and to_regprocedure('public.undo_mark_seen(uuid)') is not null,
    'public_rate_limit_primary_key',
      exists (
        select 1 from pg_constraint
        where conrelid = 'public.public_rate_limit_buckets'::regclass
          and conname = 'public_rate_limit_buckets_pkey'
          and contype = 'p'
          and convalidated
      )
  );

  v_grants := jsonb_build_object(
    'patients_status_token_authenticated_select',
      has_column_privilege('authenticated', 'public.patients', 'status_token', 'SELECT'),
    'patient_status_by_token_authenticated_execute',
      has_function_privilege('authenticated', 'public.patient_status_by_token(text)', 'EXECUTE'),
    'patient_status_by_token_anon_execute',
      has_function_privilege('anon', 'public.patient_status_by_token(text)', 'EXECUTE'),
    'patient_status_by_token_service_role_execute',
      has_function_privilege('service_role', 'public.patient_status_by_token(text)', 'EXECUTE'),
    'sms_deliveries_authenticated_select',
      has_table_privilege('authenticated', 'public.sms_deliveries', 'SELECT'),
    'claim_sms_delivery_service_role_execute',
      has_function_privilege(
        'service_role',
        'public.claim_sms_delivery(uuid,public.sms_delivery_kind,text,integer)',
        'EXECUTE'
      ),
    'complete_sms_delivery_service_role_execute',
      has_function_privilege(
        'service_role',
        'public.complete_sms_delivery(uuid,uuid,text,text,text)',
        'EXECUTE'
      ),
    'upsert_camp_day_authenticated_execute',
      has_function_privilege(
        'authenticated',
        'public.upsert_camp_day(uuid,date,integer,uuid)',
        'EXECUTE'
      ),
    'check_in_patient_authenticated_execute',
      has_function_privilege('authenticated', 'public.check_in_patient(uuid,integer)', 'EXECUTE'),
    'lookup_patient_scan_authenticated_execute',
      has_function_privilege('authenticated', 'public.lookup_patient_scan(uuid,integer)', 'EXECUTE'),
    'mark_seen_authenticated_execute',
      has_function_privilege('authenticated', 'public.mark_seen(uuid,integer)', 'EXECUTE'),
    'mark_seen_anon_execute',
      has_function_privilege('anon', 'public.mark_seen(uuid,integer)', 'EXECUTE'),
    'undo_mark_seen_authenticated_execute',
      has_function_privilege('authenticated', 'public.undo_mark_seen(uuid)', 'EXECUTE'),
    'register_patient_idempotent_authenticated_execute',
      has_function_privilege(
        'authenticated',
        'public.register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean,boolean,text,text,date,text)',
        'EXECUTE'
      ),
    'lookup_patient_status_token_anon_execute',
      has_function_privilege('anon', 'public.lookup_patient_status_token(integer,date)', 'EXECUTE'),
    'lookup_patient_status_token_authenticated_execute',
      has_function_privilege('authenticated', 'public.lookup_patient_status_token(integer,date)', 'EXECUTE'),
    'lookup_patient_status_token_service_role_execute',
      has_function_privilege('service_role', 'public.lookup_patient_status_token(integer,date)', 'EXECUTE'),
    'consume_public_rate_limit_anon_execute',
      has_function_privilege('anon', 'public.consume_public_rate_limit(text,text[],integer,integer)', 'EXECUTE'),
    'consume_public_rate_limit_authenticated_execute',
      has_function_privilege('authenticated', 'public.consume_public_rate_limit(text,text[],integer,integer)', 'EXECUTE'),
    'consume_public_rate_limit_service_role_execute',
      has_function_privilege('service_role', 'public.consume_public_rate_limit(text,text[],integer,integer)', 'EXECUTE'),
    'staff_person_kpis_authenticated_execute',
      has_function_privilege('authenticated', 'public.staff_person_kpis(uuid,text,uuid,timestamptz,text)', 'EXECUTE'),
    'staff_person_kpis_anon_execute',
      has_function_privilege('anon', 'public.staff_person_kpis(uuid,text,uuid,timestamptz,text)', 'EXECUTE'),
    'staff_person_kpis_service_role_execute',
      has_function_privilege('service_role', 'public.staff_person_kpis(uuid,text,uuid,timestamptz,text)', 'EXECUTE'),
    'staff_leaderboard_authenticated_execute',
      to_regprocedure('public.staff_leaderboard(uuid,uuid)') is not null,
    'mark_sms_dispatch_started_authenticated_execute',
      has_function_privilege('authenticated', 'public.mark_sms_dispatch_started(uuid,uuid)', 'EXECUTE'),
    'mark_sms_dispatch_started_service_role_execute',
      has_function_privilege('service_role', 'public.mark_sms_dispatch_started(uuid,uuid)', 'EXECUTE'),
    'patient_registration_notify_fields_authenticated_execute',
      has_function_privilege('authenticated', 'public.patient_registration_notify_fields(uuid)', 'EXECUTE'),
    'latest_applied_migration_service_role_execute',
      has_function_privilege('service_role', 'public.latest_applied_migration()', 'EXECUTE')
  );

  select jsonb_object_agg(
    expected.name,
    exists (
      select 1
      from pg_enum as e
      join pg_type as t on t.oid = e.enumtypid
      join pg_namespace as n on n.oid = t.typnamespace
      where n.nspname = 'public'
        and t.typname = 'sms_delivery_state'
        and e.enumlabel = expected.name
    )
  )
  into v_states
  from (
    values ('pending'), ('sending'), ('sent'), ('failed'), ('ambiguous')
  ) as expected(name);

  -- The deferral kinds are dead but stay listed: Postgres cannot drop an enum
  -- value, so the honest probe reports what the type actually holds.
  select jsonb_object_agg(
    expected.name,
    exists (
      select 1
      from pg_enum as e
      join pg_type as t on t.oid = e.enumtypid
      join pg_namespace as n on n.oid = t.typnamespace
      where n.nspname = 'public'
        and t.typname = 'sms_delivery_kind'
        and e.enumlabel = expected.name
    )
  )
  into v_kinds
  from (
    values ('registration'), ('reminder')
  ) as expected(name);

  return jsonb_build_object(
    'tables', v_tables,
    'columns', v_columns,
    'functions', v_functions,
    'invariants', v_invariants,
    'grants', v_grants,
    'publication', jsonb_build_object(
      'patients_in_supabase_realtime',
      exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'patients'
      )
    ),
    'sms', jsonb_build_object(
      'table', to_regclass('public.sms_deliveries') is not null,
      'states', v_states,
      'kinds', v_kinds,
      'claim_fn',
        to_regprocedure(
          'public.claim_sms_delivery(uuid,public.sms_delivery_kind,text,integer)'
        ) is not null,
      'complete_fn',
        to_regprocedure(
          'public.complete_sms_delivery(uuid,uuid,text,text,text)'
        ) is not null
    )
  );
end;
$function$;

commit;
