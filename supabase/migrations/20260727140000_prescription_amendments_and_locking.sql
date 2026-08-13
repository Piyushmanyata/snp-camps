-- Ticket #96 — Prescription edit, lock on first fulfillment, and append-only amendments.
-- Create prescription_amendments table, RLS policies, add_prescription_amendment RPC,
-- and update doctor_submit_prescription and lookup_patient_scan RPCs.

CREATE TABLE IF NOT EXISTS public.prescription_amendments (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  prescription_id uuid NOT NULL REFERENCES public.prescriptions(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  content text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.prescription_amendments OWNER TO postgres;

CREATE INDEX IF NOT EXISTS prescription_amendments_prescription_id_idx
  ON public.prescription_amendments (prescription_id);

ALTER TABLE public.prescription_amendments ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA public TO authenticated, service_role;
GRANT ALL ON public.prescription_amendments TO authenticated, service_role;
REVOKE ALL ON public.prescription_amendments FROM anon, PUBLIC;

DROP POLICY IF EXISTS "staff read prescription_amendments" ON public.prescription_amendments;
CREATE POLICY "staff read prescription_amendments" ON public.prescription_amendments
  FOR SELECT TO authenticated
  USING (public.is_camp_crew());

DROP POLICY IF EXISTS "doctors/admins insert prescription_amendments" ON public.prescription_amendments;
CREATE POLICY "doctors/admins insert prescription_amendments" ON public.prescription_amendments
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid())
        AND p.role IN ('doctor', 'admin')
        AND p.disabled_at IS NULL
    )
  );

-- RPC: add_prescription_amendment
CREATE OR REPLACE FUNCTION public.add_prescription_amendment(
  p_prescription_id uuid,
  p_content text
)
RETURNS SETOF public.prescription_amendments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
#variable_conflict use_column
declare
  v_caller_role public.user_role;
  v_caller_id uuid;
  v_prescription public.prescriptions%rowtype;
  v_amendment public.prescription_amendments%rowtype;
  v_content text;
begin
  v_caller_id := (select auth.uid());
  select p.role into v_caller_role
  from public.profiles p
  where p.id = v_caller_id
    and p.disabled_at is null;

  if v_caller_role is null or v_caller_role not in ('doctor', 'admin') then
    raise exception 'doctor or admin required';
  end if;

  if p_prescription_id is null then
    raise exception 'prescription_id is required';
  end if;

  v_content := nullif(trim(p_content), '');
  if v_content is null then
    raise exception 'amendment content is required';
  end if;

  select * into v_prescription
  from public.prescriptions
  where id = p_prescription_id;

  if v_prescription.id is null then
    raise exception 'Prescription not found';
  end if;

  insert into public.prescription_amendments (
    prescription_id,
    author_id,
    content,
    created_at
  )
  values (
    p_prescription_id,
    v_caller_id,
    v_content,
    now()
  )
  returning * into v_amendment;

  return next v_amendment;
end;
$$;

ALTER FUNCTION public.add_prescription_amendment(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.add_prescription_amendment(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_prescription_amendment(uuid, text) TO authenticated, service_role, postgres;

-- Update doctor_submit_prescription with lock check and order reconciliation
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
  created_orders_count integer
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
  v_prescription_id uuid;
  v_kind text;
  v_orders_count integer := 0;
  v_spectacles_type text;
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
          status
        )
        values (
          v_prescription_id,
          p_patient_id,
          v_patient.camp_id,
          v_kind,
          'pending'
        )
        on conflict (patient_id, kind) where (status = 'pending')
        do update set
          prescription_id = EXCLUDED.prescription_id,
          camp_id = EXCLUDED.camp_id,
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
    v_orders_count;
end;
$$;

ALTER FUNCTION public.doctor_submit_prescription(uuid, text, text, text, text, text, text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.doctor_submit_prescription(uuid, text, text, text, text, text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.doctor_submit_prescription(uuid, text, text, text, text, text, text[]) TO authenticated, service_role, postgres;

-- Update lookup_patient_scan to return existing prescription details, order statuses, locked state, and amendments
DROP FUNCTION IF EXISTS public.lookup_patient_scan(uuid, integer);
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
  amendments jsonb
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

  -- Load existing prescription if patient was seen or prescription exists
  select * into v_prescription
  from public.prescriptions p
  where p.patient_id = r.id;

  if v_prescription.id is not null then
    -- Destinations: active pending treatment order kinds (or all active kinds for this prescription)
    select coalesce(array_agg(t.kind), array[]::text[])
    into v_destinations
    from public.treatment_orders t
    where t.patient_id = r.id and t.status = 'pending';

    -- Lock status: true if ANY order for this patient is acted upon (fulfilled, deferred, or cancelled)
    select exists (
      select 1
      from public.treatment_orders t
      where t.patient_id = r.id
        and t.status in ('fulfilled', 'deferred', 'cancelled')
    ) into v_is_locked;

    -- Amendments
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
    v_amendments;
end;
$$;

COMMENT ON FUNCTION public.lookup_patient_scan(p_patient_id uuid, p_reg_no integer) IS
  'Camp-crew patient lookup for QR/reg scan. Returns prescription details, lock status, and amendments when seen. No side effects.';

REVOKE ALL ON FUNCTION public.lookup_patient_scan(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lookup_patient_scan(uuid, integer) TO authenticated, service_role, postgres;
