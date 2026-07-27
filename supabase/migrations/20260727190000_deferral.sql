-- Ticket #99 — Deferral state and snapshot.
-- Implements bifocal deferral at doctor, fixed glasses deferral at counter, post-camp surgery deferral when OT is full,
-- immutable order snapshots, pharmacy deferral prohibition, admin deferred lists, and unconfigured settings checks.

-- Add deferral columns to treatment_orders if not present
ALTER TABLE public.treatment_orders
  ADD COLUMN IF NOT EXISTS deferred_at timestamp with time zone NULL,
  ADD COLUMN IF NOT EXISTS deferred_by uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deferred_date date NULL,
  ADD COLUMN IF NOT EXISTS deferred_venue text NULL;

-- Enforce no pharmacy deferral at table level
ALTER TABLE public.treatment_orders DROP CONSTRAINT IF EXISTS treatment_orders_no_pharmacy_deferral;
ALTER TABLE public.treatment_orders ADD CONSTRAINT treatment_orders_no_pharmacy_deferral CHECK (NOT (kind = 'pharmacy' AND status = 'deferred'));

-- Drop old signatures to allow clean function replacement
DROP FUNCTION IF EXISTS public.resolve_treatment_order(uuid, text, date, text);
DROP FUNCTION IF EXISTS public.doctor_submit_prescription(uuid, text, text, text, text, text, text[]);

-- RPC: resolve_treatment_order (Counter desk order resolution with auto-snapshot and pharmacy restriction)
CREATE OR REPLACE FUNCTION public.resolve_treatment_order(
  p_order_id uuid,
  p_action text,
  p_deferred_date date DEFAULT NULL,
  p_deferred_venue text DEFAULT NULL
)
RETURNS SETOF public.treatment_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
#variable_conflict use_column
declare
  v_order public.treatment_orders%rowtype;
  v_action text;
  v_camp public.camps%rowtype;
  v_target_date date;
  v_target_venue text;
begin
  if not public.is_camp_crew() then
    raise exception 'active camp crew required';
  end if;

  if p_order_id is null then
    raise exception 'order_id is required';
  end if;

  v_action := lower(trim(p_action));
  if v_action not in ('fulfilled', 'deferred', 'cancelled') then
    raise exception 'Action must be fulfilled, deferred, or cancelled';
  end if;

  select * into v_order
  from public.treatment_orders
  where id = p_order_id
  for update;

  if v_order.id is null then
    raise exception 'Treatment order not found';
  end if;

  if v_order.status != 'pending' then
    raise exception 'Treatment order is already closed';
  end if;

  if v_action = 'deferred' then
    if v_order.kind = 'pharmacy' then
      raise exception 'Pharmacy orders cannot be deferred';
    end if;

    select * into v_camp
    from public.camps
    where id = v_order.camp_id;

    if v_order.kind = 'spectacles' then
      v_target_date := coalesce(p_deferred_date, v_camp.spectacles_collection_date);
      v_target_venue := coalesce(nullif(trim(p_deferred_venue), ''), v_camp.spectacles_collection_venue);
      if v_target_date is null or v_target_venue is null or trim(v_target_venue) = '' then
        raise exception 'Spectacles collection date and venue must be configured by admin';
      end if;
    elsif v_order.kind = 'ot' then
      v_target_date := coalesce(p_deferred_date, v_camp.post_camp_surgery_date);
      v_target_venue := coalesce(nullif(trim(p_deferred_venue), ''), v_camp.post_camp_surgery_venue);
      if v_target_date is null or v_target_venue is null or trim(v_target_venue) = '' then
        raise exception 'Post-camp surgery date and venue must be configured by admin';
      end if;
    else
      v_target_date := p_deferred_date;
      v_target_venue := nullif(trim(p_deferred_venue), '');
    end if;
  end if;

  update public.treatment_orders
  set status = v_action,
      closed_at = now(),
      closed_by = (select auth.uid()),
      deferred_at = case when v_action = 'deferred' then now() else null end,
      deferred_by = case when v_action = 'deferred' then (select auth.uid()) else null end,
      deferred_date = case when v_action = 'deferred' then v_target_date else null end,
      deferred_venue = case when v_action = 'deferred' then v_target_venue else null end,
      updated_at = now()
  where id = p_order_id
  returning * into v_order;

  return next v_order;
end;
$$;

ALTER FUNCTION public.resolve_treatment_order(uuid, text, date, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.resolve_treatment_order(uuid, text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_treatment_order(uuid, text, date, text) TO authenticated, service_role, postgres;

-- RPC: doctor_submit_prescription (with bifocal auto-deferral, OT overflow, and post-camp surgery fallback deferral)
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
  v_camp public.camps%rowtype;
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
  v_found_ot_day boolean := false;
  v_ot_is_deferred boolean := false;
  v_ot_deferred_date date := null;
  v_ot_deferred_venue text := null;
  v_spec_is_deferred boolean := false;
  v_spec_deferred_date date := null;
  v_spec_deferred_venue text := null;
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

  select * into v_camp
  from public.camps c
  where c.id = v_patient.camp_id;

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

  v_spectacles_type := nullif(trim(p_spectacles_type), '');
  if v_spectacles_type is not null and v_spectacles_type not in ('fixed', 'bifocal') then
    raise exception 'spectacles_type must be fixed or bifocal';
  end if;

  -- Check bifocal spectacles auto-deferral precondition
  if p_destinations is not null and 'spectacles' = any(p_destinations) and v_spectacles_type = 'bifocal' then
    if v_camp.spectacles_collection_date is null or v_camp.spectacles_collection_venue is null or trim(v_camp.spectacles_collection_venue) = '' then
      raise exception 'Spectacles collection date and venue must be configured by admin';
    end if;
    v_spec_is_deferred := true;
    v_spec_deferred_date := v_camp.spectacles_collection_date;
    v_spec_deferred_venue := v_camp.spectacles_collection_venue;
  end if;

  -- Check OT capacity & overflow / post-camp surgery deferral fallback
  if p_destinations is not null and 'ot' = any(p_destinations) then
    select exists (
      select 1
      from public.treatment_orders t
      where t.patient_id = p_patient_id
        and t.kind = 'ot'
        and t.status != 'cancelled'
    ) into v_already_has_ot;

    if v_already_has_ot then
      select t.scheduled_camp_day_id, t.deferred_date into v_target_day_id, v_ot_deferred_date
      from public.treatment_orders t
      where t.patient_id = p_patient_id
        and t.kind = 'ot'
        and t.status != 'cancelled'
      limit 1;

      if v_target_day_id is not null then
        select d.day_date into v_target_day_date
        from public.camp_days d
        where d.id = v_target_day_id;
      elsif v_ot_deferred_date is not null then
        v_target_day_date := v_ot_deferred_date;
      elsif v_current_camp_day.id is not null then
        v_target_day_id := v_current_camp_day.id;
        v_target_day_date := v_current_camp_day.day_date;
      end if;
    else
      -- Search available capacity starting with current camp day
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
          v_found_ot_day := true;
        else
          -- Search future camp days FOR UPDATE
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
              v_found_ot_day := true;
              exit;
            end if;
          end loop;

          if not v_found_ot_day then
            -- Fall back to post-camp surgery deferral
            if v_camp.post_camp_surgery_date is null or v_camp.post_camp_surgery_venue is null or trim(v_camp.post_camp_surgery_venue) = '' then
              raise exception 'Post-camp surgery date and venue must be configured by admin';
            end if;
            v_ot_is_deferred := true;
            v_ot_deferred_date := v_camp.post_camp_surgery_date;
            v_ot_deferred_venue := v_camp.post_camp_surgery_venue;
            v_target_day_date := v_camp.post_camp_surgery_date;
          end if;
        end if;
      end if;
    end if;
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

  -- Delete pending orders for kinds removed from p_destinations
  delete from public.treatment_orders
  where patient_id = p_patient_id
    and status = 'pending'
    and kind not in (select unnest(p_destinations));

  if p_destinations is not null and array_length(p_destinations, 1) > 0 then
    foreach v_kind in array p_destinations loop
      v_kind := lower(trim(v_kind));
      if v_kind in ('ot', 'pharmacy', 'spectacles') then
        if v_kind = 'spectacles' and v_spec_is_deferred then
          insert into public.treatment_orders (
            prescription_id,
            patient_id,
            camp_id,
            kind,
            status,
            closed_at,
            closed_by,
            deferred_at,
            deferred_by,
            deferred_date,
            deferred_venue
          )
          values (
            v_prescription_id,
            p_patient_id,
            v_patient.camp_id,
            'spectacles',
            'deferred',
            now(),
            v_caller_id,
            now(),
            v_caller_id,
            v_spec_deferred_date,
            v_spec_deferred_venue
          )
          on conflict (patient_id, kind) where (status = 'pending')
          do update set
            prescription_id = EXCLUDED.prescription_id,
            status = 'deferred',
            closed_at = now(),
            closed_by = v_caller_id,
            deferred_at = now(),
            deferred_by = v_caller_id,
            deferred_date = v_spec_deferred_date,
            deferred_venue = v_spec_deferred_venue,
            updated_at = now();
        elsif v_kind = 'ot' and v_ot_is_deferred then
          insert into public.treatment_orders (
            prescription_id,
            patient_id,
            camp_id,
            kind,
            status,
            closed_at,
            closed_by,
            deferred_at,
            deferred_by,
            deferred_date,
            deferred_venue
          )
          values (
            v_prescription_id,
            p_patient_id,
            v_patient.camp_id,
            'ot',
            'deferred',
            now(),
            v_caller_id,
            now(),
            v_caller_id,
            v_ot_deferred_date,
            v_ot_deferred_venue
          )
          on conflict (patient_id, kind) where (status = 'pending')
          do update set
            prescription_id = EXCLUDED.prescription_id,
            status = 'deferred',
            closed_at = now(),
            closed_by = v_caller_id,
            deferred_at = now(),
            deferred_by = v_caller_id,
            deferred_date = v_ot_deferred_date,
            deferred_venue = v_ot_deferred_venue,
            updated_at = now();
        else
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
        end if;

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

-- RPC: admin_list_deferred_orders (Allows admins to list deferred spectacles or surgery orders)
CREATE OR REPLACE FUNCTION public.admin_list_deferred_orders(
  p_camp_id uuid DEFAULT NULL,
  p_kind text DEFAULT NULL
)
RETURNS TABLE(
  order_id uuid,
  patient_id uuid,
  reg_no integer,
  full_name text,
  phone text,
  kind text,
  deferred_date date,
  deferred_venue text,
  deferred_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
begin
  if not public.is_admin() then
    raise exception 'admin required';
  end if;

  return query
  select
    t.id as order_id,
    p.id as patient_id,
    p.reg_no,
    p.full_name,
    p.phone,
    t.kind,
    t.deferred_date,
    t.deferred_venue,
    t.deferred_at
  from public.treatment_orders t
  join public.patients p on p.id = t.patient_id
  where t.status = 'deferred'
    and (p_camp_id is null or t.camp_id = p_camp_id)
    and (p_kind is null or t.kind = lower(trim(p_kind)))
  order by t.deferred_date asc, p.reg_no asc;
end;
$$;

ALTER FUNCTION public.admin_list_deferred_orders(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_list_deferred_orders(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_deferred_orders(uuid, text) TO authenticated, service_role, postgres;
