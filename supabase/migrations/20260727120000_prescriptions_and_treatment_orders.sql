-- Ticket #90 — Prescription and treatment orders foundation.
-- Create prescriptions and treatment orders tables, indexes, RLS policies,
-- and doctor_submit_prescription RPC.

CREATE TABLE IF NOT EXISTS public.prescriptions (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  patient_id uuid NOT NULL UNIQUE REFERENCES public.patients(id) ON DELETE RESTRICT,
  camp_id uuid NOT NULL REFERENCES public.camps(id) ON DELETE RESTRICT,
  doctor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  diagnosis text,
  examination text,
  medicines text,
  advice text,
  spectacles_type text CONSTRAINT prescriptions_spectacles_type_check CHECK (spectacles_type IN ('fixed', 'bifocal')),
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.prescriptions OWNER TO postgres;

CREATE TABLE IF NOT EXISTS public.treatment_orders (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  prescription_id uuid REFERENCES public.prescriptions(id) ON DELETE CASCADE,
  patient_id uuid REFERENCES public.patients(id) ON DELETE RESTRICT,
  camp_id uuid REFERENCES public.camps(id) ON DELETE RESTRICT,
  kind text CONSTRAINT treatment_orders_kind_check CHECK (kind IN ('ot', 'pharmacy', 'spectacles')),
  status text DEFAULT 'pending' CONSTRAINT treatment_orders_status_check CHECK (status IN ('pending', 'fulfilled', 'deferred', 'cancelled')),
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  closed_at timestamp with time zone,
  closed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  deferred_date date,
  deferred_venue text
);

ALTER TABLE public.treatment_orders OWNER TO postgres;

-- Unique partial index for pending treatment orders per patient and kind
CREATE UNIQUE INDEX IF NOT EXISTS treatment_orders_pending_patient_kind_idx
  ON public.treatment_orders (patient_id, kind)
  WHERE (status = 'pending');

-- Indexes
CREATE INDEX IF NOT EXISTS prescriptions_camp_id_idx ON public.prescriptions (camp_id);
CREATE INDEX IF NOT EXISTS prescriptions_doctor_id_idx ON public.prescriptions (doctor_id);
CREATE INDEX IF NOT EXISTS treatment_orders_prescription_id_idx ON public.treatment_orders (prescription_id);
CREATE INDEX IF NOT EXISTS treatment_orders_camp_id_idx ON public.treatment_orders (camp_id);
CREATE INDEX IF NOT EXISTS treatment_orders_status_idx ON public.treatment_orders (status);

-- RLS & Permissions
ALTER TABLE public.prescriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.treatment_orders ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA public TO authenticated, service_role;
GRANT ALL ON public.prescriptions TO authenticated, service_role;
GRANT ALL ON public.treatment_orders TO authenticated, service_role;
REVOKE ALL ON public.prescriptions FROM anon, PUBLIC;
REVOKE ALL ON public.treatment_orders FROM anon, PUBLIC;

-- RLS Policies: Prescriptions (Staff / is_camp_crew only)
DROP POLICY IF EXISTS "staff read prescriptions" ON public.prescriptions;
CREATE POLICY "staff read prescriptions" ON public.prescriptions
  FOR SELECT TO authenticated
  USING (public.is_camp_crew());

DROP POLICY IF EXISTS "staff insert prescriptions" ON public.prescriptions;
CREATE POLICY "staff insert prescriptions" ON public.prescriptions
  FOR INSERT TO authenticated
  WITH CHECK (public.is_camp_crew());

DROP POLICY IF EXISTS "staff update prescriptions" ON public.prescriptions;
CREATE POLICY "staff update prescriptions" ON public.prescriptions
  FOR UPDATE TO authenticated
  USING (public.is_camp_crew())
  WITH CHECK (public.is_camp_crew());

-- RLS Policies: Treatment Orders (Staff / is_camp_crew only)
DROP POLICY IF EXISTS "staff read treatment_orders" ON public.treatment_orders;
CREATE POLICY "staff read treatment_orders" ON public.treatment_orders
  FOR SELECT TO authenticated
  USING (public.is_camp_crew());

DROP POLICY IF EXISTS "staff insert treatment_orders" ON public.treatment_orders;
CREATE POLICY "staff insert treatment_orders" ON public.treatment_orders
  FOR INSERT TO authenticated
  WITH CHECK (public.is_camp_crew());

DROP POLICY IF EXISTS "staff update treatment_orders" ON public.treatment_orders;
CREATE POLICY "staff update treatment_orders" ON public.treatment_orders
  FOR UPDATE TO authenticated
  USING (public.is_camp_crew())
  WITH CHECK (public.is_camp_crew());

DROP POLICY IF EXISTS "staff delete treatment_orders" ON public.treatment_orders;
CREATE POLICY "staff delete treatment_orders" ON public.treatment_orders
  FOR DELETE TO authenticated
  USING (public.is_camp_crew());

-- Stored Procedure RPC doctor_submit_prescription
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
