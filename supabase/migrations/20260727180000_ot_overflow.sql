-- Ticket #95 — Theatre overflow to the next camp day.
-- Adds scheduled_camp_day_id column to treatment_orders table,
-- updates doctor_submit_prescription, upsert_camp_day, lookup_patient_scan, and readiness_catalog_probe RPCs.

ALTER TABLE public.treatment_orders
  ADD COLUMN IF NOT EXISTS scheduled_camp_day_id uuid NULL REFERENCES public.camp_days(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS treatment_orders_scheduled_camp_day_id_idx
  ON public.treatment_orders (scheduled_camp_day_id);

-- Drop old signatures to allow clean function replacement
DROP FUNCTION IF EXISTS public.doctor_submit_prescription(uuid, text, text, text, text, text, text[]);
DROP FUNCTION IF EXISTS public.lookup_patient_scan(uuid, integer);

-- RPC: doctor_submit_prescription (with theatre overflow rollover and capacity check)
CREATE OR REPLACE FUNCTION public.doctor_submit_prescription(
  p_patient_id uuid,
  p_diagnosis text DEFAULT NULL,
  p_examination text DEFAULT NULL,
  p_medicines text DEFAULT NULL,
  p_advice text DEFAULT NULL,
  p_spectacles_type text DEFAULT NULL,
  p_destinations text[] DEFAULT ARRAY[]::text[]
)
RETURNS TABLE(
  prescription_id uuid,
  patient_id uuid,
  reg_no integer,
  queue_status public.queue_status,
  created_orders_count integer,
  scheduled_camp_day_id uuid,
  scheduled_day_date date
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
#variable_conflict use_column
declare
  v_caller_role public.user_role;
  v_caller_id uuid;
  v_patient public.patients%rowtype;
  v_current_camp_day public.camp_days%rowtype;
  v_future_day record;
  v_target_day_id uuid := null;
  v_target_day_date date := null;
  v_prescription_id uuid;
  v_kind text;
  v_orders_count integer := 0;
  v_spectacles_type text;
  v_already_has_ot boolean := false;
  v_ot_reserved integer := 0;
  v_found_day boolean := false;
begin
  v_caller_id := (select auth.uid());
  select p.role into v_caller_role
  from public.profiles p
  where p.id = v_caller_id
    and p.disabled_at is null;

  if v_caller_role is null or v_caller_role not in ('doctor', 'admin') then
    raise exception 'doctor or admin required';
  end if;

  if p_patient_id is null then
    raise exception 'patient_id is required';
  end if;

  select * into v_patient
  from public.patients p
  where p.id = p_patient_id
  for update;

  if v_patient.id is null then
    raise exception 'Patient not found';
  end if;

  if v_patient.queue_status not in ('waiting', 'seen') then
    raise exception 'Patient must be in waiting or seen state';
  end if;

  -- Lock patient's current camp_day row
  if v_patient.camp_day_id is not null then
    select * into v_current_camp_day
    from public.camp_days d
    where d.id = v_patient.camp_day_id
    for update;
  end if;

  -- Check locked state: If ANY treatment order for patient has status fulfilled/deferred/cancelled
  if exists (
    select 1
    from public.treatment_orders t
    where t.patient_id = p_patient_id
      and t.status in ('fulfilled', 'deferred', 'cancelled')
  ) then
    raise exception 'Prescription is locked because treatment orders have been acted upon';
  end if;

  -- If 'ot' destination requested, check capacity & overflow
  if p_destinations is not null and 'ot' = any(p_destinations) then
    select exists (
      select 1
      from public.treatment_orders t
      where t.patient_id = p_patient_id
        and t.kind = 'ot'
        and t.status != 'cancelled'
    ) into v_already_has_ot;

    if v_already_has_ot then
      -- Patient already has active OT order: reuse its scheduled day
      select t.scheduled_camp_day_id into v_target_day_id
      from public.treatment_orders t
      where t.patient_id = p_patient_id
        and t.kind = 'ot'
        and t.status != 'cancelled'
      limit 1;

      if v_target_day_id is not null then
        select d.day_date into v_target_day_date
        from public.camp_days d
        where d.id = v_target_day_id;
      elsif v_current_camp_day.id is not null then
        v_target_day_id := v_current_camp_day.id;
        v_target_day_date := v_current_camp_day.day_date;
      end if;
    else
      -- New OT order: find available capacity starting with current camp day
      if v_current_camp_day.id is not null then
        select count(*)::integer
        into v_ot_reserved
        from public.treatment_orders t
        join public.patients p on p.id = t.patient_id
        where coalesce(t.scheduled_camp_day_id, p.camp_day_id) = v_current_camp_day.id
          and t.kind = 'ot'
          and t.status != 'cancelled';

        if v_current_camp_day.theatre_capacity is null or v_ot_reserved < v_current_camp_day.theatre_capacity then
          v_target_day_id := v_current_camp_day.id;
          v_target_day_date := v_current_camp_day.day_date;
          v_found_day := true;
        else
          -- Current camp day is full: search future camp days for the camp in date order FOR UPDATE
          for v_future_day in
            select d.id, d.day_date, d.theatre_capacity
            from public.camp_days d
            where d.camp_id = v_patient.camp_id
              and d.day_date > v_current_camp_day.day_date
            order by d.day_date asc
            for update
          loop
            select count(*)::integer
            into v_ot_reserved
            from public.treatment_orders t
            join public.patients p on p.id = t.patient_id
            where coalesce(t.scheduled_camp_day_id, p.camp_day_id) = v_future_day.id
              and t.kind = 'ot'
              and t.status != 'cancelled';

            if v_future_day.theatre_capacity is null or v_ot_reserved < v_future_day.theatre_capacity then
              v_target_day_id := v_future_day.id;
              v_target_day_date := v_future_day.day_date;
              v_found_day := true;
              exit;
            end if;
          end loop;

          if not v_found_day then
            raise exception 'Camp has no theatre capacity remaining';
          end if;
        end if;
      end if;
    end if;
  end if;

  v_spectacles_type := nullif(trim(p_spectacles_type), '');
  if v_spectacles_type is not null and v_spectacles_type not in ('fixed', 'bifocal') then
    raise exception 'spectacles_type must be fixed or bifocal';
  end if;

  insert into public.prescriptions (
    patient_id,
    camp_id,
    doctor_id,
    diagnosis,
    examination,
    medicines,
    advice,
    spectacles_type,
    updated_at
  )
  values (
    p_patient_id,
    v_patient.camp_id,
    v_caller_id,
    nullif(trim(p_diagnosis), ''),
    nullif(trim(p_examination), ''),
    nullif(trim(p_medicines), ''),
    nullif(trim(p_advice), ''),
    v_spectacles_type,
    now()
  )
  on conflict (patient_id) do update set
    camp_id = EXCLUDED.camp_id,
    doctor_id = EXCLUDED.doctor_id,
    diagnosis = EXCLUDED.diagnosis,
    examination = EXCLUDED.examination,
    medicines = EXCLUDED.medicines,
    advice = EXCLUDED.advice,
    spectacles_type = EXCLUDED.spectacles_type,
    updated_at = now()
  returning public.prescriptions.id into v_prescription_id;

  if v_patient.queue_status = 'waiting' then
    update public.patients
    set queue_status = 'seen',
        seen_at = coalesce(seen_at, now()),
        seen_by = coalesce(seen_by, v_caller_id)
    where public.patients.id = p_patient_id;
    v_patient.queue_status := 'seen';
  end if;

  -- Order reconciliation: delete pending orders for kinds removed from p_destinations
  delete from public.treatment_orders
  where patient_id = p_patient_id
    and status = 'pending'
    and kind not in (select unnest(p_destinations));

  if p_destinations is not null and array_length(p_destinations, 1) > 0 then
    foreach v_kind in array p_destinations loop
      v_kind := lower(trim(v_kind));
      if v_kind in ('ot', 'pharmacy', 'spectacles') then
        insert into public.treatment_orders (
          prescription_id,
          patient_id,
          camp_id,
          kind,
          status,
          scheduled_camp_day_id
        )
        values (
          v_prescription_id,
          p_patient_id,
          v_patient.camp_id,
          v_kind,
          'pending',
          case when v_kind = 'ot' then v_target_day_id else null end
        )
        on conflict (patient_id, kind) where (status = 'pending')
        do update set
          prescription_id = EXCLUDED.prescription_id,
          camp_id = EXCLUDED.camp_id,
          scheduled_camp_day_id = case
            when v_kind = 'ot' then coalesce(treatment_orders.scheduled_camp_day_id, EXCLUDED.scheduled_camp_day_id)
            else null
          end,
          updated_at = now();

        v_orders_count := v_orders_count + 1;
      end if;
    end loop;
  end if;

  return query
  select
    v_prescription_id,
    v_patient.id,
    v_patient.reg_no,
    v_patient.queue_status,
    v_orders_count,
    v_target_day_id,
    v_target_day_date;
end;
$$;

ALTER FUNCTION public.doctor_submit_prescription(uuid, text, text, text, text, text, text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.doctor_submit_prescription(uuid, text, text, text, text, text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.doctor_submit_prescription(uuid, text, text, text, text, text, text[]) TO authenticated, service_role, postgres;

-- Update upsert_camp_day to count scheduled OT orders correctly
CREATE OR REPLACE FUNCTION public.upsert_camp_day(
  p_camp_id uuid,
  p_day_date date,
  p_seat_limit integer,
  p_day_id uuid DEFAULT NULL::uuid,
  p_theatre_capacity integer DEFAULT NULL::integer
)
RETURNS public.camp_days
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  r public.camp_days;
  v_taken integer;
  v_ot_reserved integer;
begin
  if not public.is_admin() then
    raise exception 'admin only';
  end if;
  if p_seat_limit is null or p_seat_limit < 0 then
    raise exception 'seat_limit must be >= 0';
  end if;
  if p_theatre_capacity is not null and p_theatre_capacity < 0 then
    raise exception 'theatre_capacity must be >= 0 or NULL';
  end if;

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

    select count(*)::integer
    into v_ot_reserved
    from public.treatment_orders t
    join public.patients p on p.id = t.patient_id
    where coalesce(t.scheduled_camp_day_id, p.camp_day_id) = p_day_id
      and t.kind = 'ot'
      and t.status != 'cancelled';

    if p_theatre_capacity is not null and p_theatre_capacity < v_ot_reserved then
      raise exception 'THEATRE_CAPACITY_BELOW_RESERVED:reserved=%', v_ot_reserved;
    end if;

    update public.camp_days d
    set day_date = p_day_date,
        seat_limit = p_seat_limit,
        theatre_capacity = p_theatre_capacity
    where d.id = p_day_id
      and d.camp_id = p_camp_id
    returning d.* into r;

    return r;
  end if;

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

    select count(*)::integer
    into v_ot_reserved
    from public.treatment_orders t
    join public.patients p on p.id = t.patient_id
    where coalesce(t.scheduled_camp_day_id, p.camp_day_id) = r.id
      and t.kind = 'ot'
      and t.status != 'cancelled';

    if p_theatre_capacity is not null and p_theatre_capacity < v_ot_reserved then
      raise exception 'THEATRE_CAPACITY_BELOW_RESERVED:reserved=%', v_ot_reserved;
    end if;

    update public.camp_days d
    set seat_limit = p_seat_limit,
        theatre_capacity = p_theatre_capacity
    where d.id = r.id
    returning d.* into r;

    return r;
  end if;

  insert into public.camp_days (camp_id, day_date, seat_limit, theatre_capacity)
  values (p_camp_id, p_day_date, p_seat_limit, p_theatre_capacity)
  returning * into r;

  return r;
end;
$function$;

-- RPC: lookup_patient_scan (with OT scheduled date and next available OT day date)
CREATE OR REPLACE FUNCTION public.lookup_patient_scan(
  p_patient_id uuid DEFAULT NULL::uuid,
  p_reg_no integer DEFAULT NULL::integer
) RETURNS TABLE(
  id uuid,
  reg_no integer,
  full_name text,
  queue_status public.queue_status,
  phone text,
  doctor_id uuid,
  doctor_name text,
  prescription_id uuid,
  diagnosis text,
  examination text,
  medicines text,
  advice text,
  spectacles_type text,
  destinations text[],
  is_locked boolean,
  amendments jsonb,
  theatre_capacity integer,
  theatre_reserved integer,
  theatre_remaining integer,
  ot_scheduled_day_id uuid,
  ot_scheduled_day_date date,
  next_available_ot_day_date date
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
#variable_conflict use_column
declare
  r public.patients%rowtype;
  v_caller_role public.user_role;
  v_doctor_name text;
  v_prescription public.prescriptions%rowtype;
  v_destinations text[];
  v_is_locked boolean := false;
  v_amendments jsonb := '[]'::jsonb;
  v_eval_day_id uuid := null;
  v_theatre_capacity integer := null;
  v_theatre_reserved integer := 0;
  v_theatre_remaining integer := null;
  v_ot_scheduled_day_id uuid := null;
  v_ot_scheduled_day_date date := null;
  v_next_available_ot_day_date date := null;
  v_current_day_date date := null;
  v_future_day record;
  v_reserved_count integer := 0;
begin
  if not public.is_camp_crew() then
    raise exception 'active camp crew only';
  end if;

  select p.role
  into v_caller_role
  from public.profiles p
  where p.id = (select auth.uid());

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

  -- Load patient's active OT order details if present
  select t.scheduled_camp_day_id, d.day_date
  into v_ot_scheduled_day_id, v_ot_scheduled_day_date
  from public.treatment_orders t
  join public.camp_days d on d.id = coalesce(t.scheduled_camp_day_id, r.camp_day_id)
  where t.patient_id = r.id
    and t.kind = 'ot'
    and t.status != 'cancelled'
  limit 1;

  v_eval_day_id := coalesce(v_ot_scheduled_day_id, r.camp_day_id);

  if v_eval_day_id is not null then
    select d.theatre_capacity, d.day_date
    into v_theatre_capacity, v_current_day_date
    from public.camp_days d
    where d.id = v_eval_day_id;

    select count(*)::integer
    into v_theatre_reserved
    from public.treatment_orders t
    join public.patients p on p.id = t.patient_id
    where coalesce(t.scheduled_camp_day_id, p.camp_day_id) = v_eval_day_id
      and t.kind = 'ot'
      and t.status != 'cancelled';

    if v_theatre_capacity is not null then
      v_theatre_remaining := greatest(0, v_theatre_capacity - v_theatre_reserved);
    end if;

    -- Calculate next available OT day date for new OT orders
    if v_theatre_capacity is null or v_theatre_reserved < v_theatre_capacity then
      v_next_available_ot_day_date := v_current_day_date;
    else
      for v_future_day in
        select d.id, d.day_date, d.theatre_capacity
        from public.camp_days d
        where d.camp_id = r.camp_id
          and d.day_date > v_current_day_date
        order by d.day_date asc
      loop
        select count(*)::integer
        into v_reserved_count
        from public.treatment_orders t
        join public.patients p on p.id = t.patient_id
        where coalesce(t.scheduled_camp_day_id, p.camp_day_id) = v_future_day.id
          and t.kind = 'ot'
          and t.status != 'cancelled';

        if v_future_day.theatre_capacity is null or v_reserved_count < v_future_day.theatre_capacity then
          v_next_available_ot_day_date := v_future_day.day_date;
          exit;
        end if;
      end loop;
    end if;
  end if;

  -- Load existing prescription if present
  select * into v_prescription
  from public.prescriptions p
  where p.patient_id = r.id;

  if v_prescription.id is not null then
    select coalesce(array_agg(t.kind), array[]::text[])
    into v_destinations
    from public.treatment_orders t
    where t.patient_id = r.id and t.status = 'pending';

    select exists (
      select 1
      from public.treatment_orders t
      where t.patient_id = r.id
        and t.status in ('fulfilled', 'deferred', 'cancelled')
    ) into v_is_locked;

    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', a.id,
          'author_id', a.author_id,
          'author_name', coalesce(pr.full_name, 'Doctor'),
          'content', a.content,
          'created_at', a.created_at
        ) order by a.created_at asc
      ),
      '[]'::jsonb
    )
    into v_amendments
    from public.prescription_amendments a
    left join public.profiles pr on pr.id = a.author_id
    where a.prescription_id = v_prescription.id;
  end if;

  return query
  select
    r.id,
    r.reg_no,
    r.full_name,
    r.queue_status,
    case when v_caller_role = 'doctor' then null::text else r.phone end,
    r.seen_by,
    v_doctor_name,
    v_prescription.id,
    v_prescription.diagnosis,
    v_prescription.examination,
    v_prescription.medicines,
    v_prescription.advice,
    v_prescription.spectacles_type,
    v_destinations,
    v_is_locked,
    v_amendments,
    v_theatre_capacity,
    v_theatre_reserved,
    v_theatre_remaining,
    v_ot_scheduled_day_id,
    v_ot_scheduled_day_date,
    v_next_available_ot_day_date;
end;
$$;

COMMENT ON FUNCTION public.lookup_patient_scan(p_patient_id uuid, p_reg_no integer) IS
  'Camp-crew patient lookup for QR/reg scan. Returns prescription details, lock status, amendments, and theatre capacity stats. No side effects.';

REVOKE ALL ON FUNCTION public.lookup_patient_scan(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lookup_patient_scan(uuid, integer) TO authenticated, service_role, postgres;

-- Update readiness_catalog_probe to check treatment_orders.scheduled_camp_day_id
CREATE OR REPLACE FUNCTION public.readiness_catalog_probe()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_tables jsonb := '{}'::jsonb;
  v_columns jsonb := '{}'::jsonb;
  v_functions jsonb := '{}'::jsonb;
  v_grants jsonb := '{}'::jsonb;
  v_states jsonb := '{}'::jsonb;
  v_kinds jsonb := '{}'::jsonb;
  v_tbl text;
  v_col text;
  v_fn text;
  v_state text;
  v_kind text;
  v_patients_in_rt boolean;
  v_required_tables text[] := ARRAY[
    'patients', 'camps', 'camp_days', 'profiles', 'sms_deliveries', 'treatment_orders'
  ];
  v_required_fns text[] := ARRAY[
    'latest_applied_migration',
    'readiness_catalog_probe',
    'patient_status_by_token',
    'upsert_camp_day',
    'register_patient_idempotent',
    'check_in_patient',
    'claim_sms_delivery',
    'complete_sms_delivery'
  ];
  v_sms_states text[] := ARRAY[
    'pending', 'sending', 'sent', 'failed', 'ambiguous'
  ];
  v_sms_kinds text[] := ARRAY['registration', 'reminder'];
BEGIN
  FOREACH v_tbl IN ARRAY v_required_tables LOOP
    v_tables := v_tables || jsonb_build_object(
      v_tbl,
      to_regclass(format('public.%I', v_tbl)) IS NOT NULL
    );
  END LOOP;

  FOR v_tbl, v_col IN
    SELECT * FROM (VALUES
      ('patients', 'id'),
      ('patients', 'status_token'),
      ('patients', 'queue_status'),
      ('patients', 'queued_at'),
      ('patients', 'reg_no'),
      ('patients', 'camp_id'),
      ('patients', 'camp_day_id'),
      ('patients', 'full_name'),
      ('camps', 'id'),
      ('camps', 'name'),
      ('camps', 'is_active'),
      ('camps', 'venue'),
      ('camp_days', 'id'),
      ('camp_days', 'camp_id'),
      ('camp_days', 'day_date'),
      ('camp_days', 'seat_limit'),
      ('camp_days', 'theatre_capacity'),
      ('profiles', 'id'),
      ('profiles', 'disabled_at'),
      ('sms_deliveries', 'id'),
      ('sms_deliveries', 'patient_id'),
      ('sms_deliveries', 'kind'),
      ('sms_deliveries', 'state'),
      ('sms_deliveries', 'claim_token'),
      ('sms_deliveries', 'phone_last4'),
      ('sms_deliveries', 'attempt_count'),
      ('sms_deliveries', 'updated_at'),
      ('treatment_orders', 'id'),
      ('treatment_orders', 'scheduled_camp_day_id')
    ) AS t(tbl, col)
  LOOP
    v_columns := v_columns || jsonb_build_object(
      v_tbl || '.' || v_col,
      EXISTS (
        SELECT 1
        FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = v_tbl
          AND c.column_name = v_col
      )
    );
  END LOOP;

  FOREACH v_fn IN ARRAY v_required_fns LOOP
    v_functions := v_functions || jsonb_build_object(
      v_fn,
      EXISTS (
        SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = v_fn
      )
    );
  END LOOP;

  v_grants := jsonb_build_object(
    'patients_status_token_authenticated_select',
    CASE
      WHEN to_regclass('public.patients') IS NULL THEN false
      ELSE has_column_privilege(
        'authenticated', 'public.patients', 'status_token', 'SELECT'
      )
    END,
    'patient_status_by_token_authenticated_execute',
    EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'patient_status_by_token'
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ),
    'patient_status_by_token_anon_execute',
    EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'patient_status_by_token'
        AND has_function_privilege('anon', p.oid, 'EXECUTE')
    ),
    'patient_status_by_token_service_role_execute',
    EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'patient_status_by_token'
        AND has_function_privilege('service_role', p.oid, 'EXECUTE')
    ),
    'sms_deliveries_authenticated_select',
    CASE
      WHEN to_regclass('public.sms_deliveries') IS NULL THEN false
      ELSE has_table_privilege('authenticated', 'public.sms_deliveries', 'SELECT')
    END,
    'claim_sms_delivery_service_role_execute',
    EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'claim_sms_delivery'
        AND has_function_privilege('service_role', p.oid, 'EXECUTE')
    ),
    'complete_sms_delivery_service_role_execute',
    EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'complete_sms_delivery'
        AND has_function_privilege('service_role', p.oid, 'EXECUTE')
    ),
    'upsert_camp_day_authenticated_execute',
    EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'upsert_camp_day'
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ),
    'check_in_patient_authenticated_execute',
    EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'check_in_patient'
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ),
    'register_patient_idempotent_authenticated_execute',
    EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'register_patient_idempotent'
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ),
    'latest_applied_migration_service_role_execute',
    EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'latest_applied_migration'
        AND has_function_privilege('service_role', p.oid, 'EXECUTE')
    )
  );

  SELECT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'patients'
  ) INTO v_patients_in_rt;

  FOREACH v_state IN ARRAY v_sms_states LOOP
    v_states := v_states || jsonb_build_object(
      v_state,
      EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public'
          AND t.typname = 'sms_delivery_state'
          AND e.enumlabel = v_state
      )
    );
  END LOOP;

  FOREACH v_kind IN ARRAY v_sms_kinds LOOP
    v_kinds := v_kinds || jsonb_build_object(
      v_kind,
      EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public'
          AND t.typname = 'sms_delivery_kind'
          AND e.enumlabel = v_kind
      )
    );
  END LOOP;

  RETURN jsonb_build_object(
    'tables', v_tables,
    'columns', v_columns,
    'functions', v_functions,
    'grants', v_grants,
    'publication', jsonb_build_object(
      'patients_in_supabase_realtime', coalesce(v_patients_in_rt, false)
    ),
    'sms', jsonb_build_object(
      'table', to_regclass('public.sms_deliveries') IS NOT NULL,
      'states', v_states,
      'kinds', v_kinds,
      'claim_fn', EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'claim_sms_delivery'
      ),
      'complete_fn', EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'complete_sms_delivery'
      )
    )
  );
END;
$$;
