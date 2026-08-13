-- Close #115's auditability and retry-safety gap for paper-camp orders.
-- Every order records its origin and creator. Repeating a counter action after
-- a fulfilled/deferred order is an idempotent no-op instead of a duplicate.

ALTER TABLE public.treatment_orders
  ADD COLUMN source text,
  ADD COLUMN created_by uuid;

UPDATE public.treatment_orders AS orders
SET
  source = CASE
    WHEN orders.prescription_id IS NULL THEN 'counter'
    ELSE 'doctor'
  END,
  created_by = CASE
    WHEN orders.prescription_id IS NULL THEN orders.closed_by
    ELSE prescriptions.doctor_id
  END
FROM public.prescriptions AS prescriptions
WHERE prescriptions.id = orders.prescription_id;

UPDATE public.treatment_orders
SET
  source = 'counter',
  created_by = closed_by
WHERE prescription_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.treatment_orders
    WHERE source IS NULL
       OR created_by IS NULL
  ) THEN
    RAISE EXCEPTION
      'Cannot attribute treatment orders: historical creator is missing';
  END IF;
END
$$;

ALTER TABLE public.treatment_orders
  ALTER COLUMN source SET NOT NULL,
  ALTER COLUMN created_by SET NOT NULL,
  ADD CONSTRAINT treatment_orders_source_check
    CHECK (source IN ('doctor', 'counter')),
  ADD CONSTRAINT treatment_orders_created_by_fkey
    FOREIGN KEY (created_by)
    REFERENCES public.profiles (id)
    ON DELETE RESTRICT;

CREATE INDEX treatment_orders_created_by_idx
  ON public.treatment_orders (created_by, created_at DESC);

CREATE OR REPLACE FUNCTION public.set_treatment_order_attribution()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_creator uuid;
BEGIN
  IF NEW.prescription_id IS NOT NULL THEN
    SELECT prescription.doctor_id
    INTO v_creator
    FROM public.prescriptions AS prescription
    WHERE prescription.id = NEW.prescription_id;

    IF v_creator IS NULL THEN
      RAISE EXCEPTION 'Prescription creator could not be resolved';
    END IF;

    NEW.source := 'doctor';
    NEW.created_by := v_creator;
  ELSE
    v_creator := (SELECT auth.uid());
    IF v_creator IS NULL OR NOT public.is_camp_crew() THEN
      RAISE EXCEPTION 'active camp crew required';
    END IF;

    NEW.source := 'counter';
    NEW.created_by := v_creator;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.set_treatment_order_attribution() FROM PUBLIC;

CREATE TRIGGER treatment_orders_set_attribution
BEFORE INSERT ON public.treatment_orders
FOR EACH ROW
EXECUTE FUNCTION public.set_treatment_order_attribution();

CREATE OR REPLACE FUNCTION public.counter_create_and_fulfill_order(
  p_patient_id uuid,
  p_kinds text[]
)
RETURNS TABLE (
  created_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_patient public.patients%rowtype;
  v_caller_id uuid;
  v_kind text;
  v_count integer := 0;
  v_order_id uuid;
  v_valid_kinds text[];
BEGIN
  IF NOT public.is_camp_crew() THEN
    RAISE EXCEPTION 'active camp crew required';
  END IF;

  IF p_patient_id IS NULL THEN
    RAISE EXCEPTION 'patient_id is required';
  END IF;

  IF p_kinds IS NULL OR coalesce(array_length(p_kinds, 1), 0) = 0 THEN
    RAISE EXCEPTION 'at least one treatment kind is required';
  END IF;

  IF array_length(p_kinds, 1) > 3 OR EXISTS (
    SELECT 1
    FROM unnest(p_kinds) AS supplied(kind)
    WHERE lower(btrim(supplied.kind)) NOT IN ('ot', 'pharmacy', 'spectacles')
  ) THEN
    RAISE EXCEPTION 'invalid treatment kind';
  END IF;

  SELECT array_agg(DISTINCT lower(btrim(supplied.kind)))
  INTO v_valid_kinds
  FROM unnest(p_kinds) AS supplied(kind);

  SELECT *
  INTO v_patient
  FROM public.patients AS patient
  WHERE patient.id = p_patient_id
  FOR UPDATE;

  IF v_patient.id IS NULL THEN
    RAISE EXCEPTION 'Patient not found';
  END IF;

  IF v_patient.queue_status <> 'seen' THEN
    RAISE EXCEPTION 'Patient consultation must be complete';
  END IF;

  v_caller_id := (SELECT auth.uid());

  FOREACH v_kind IN ARRAY v_valid_kinds LOOP
    v_order_id := NULL;

    UPDATE public.treatment_orders AS orders
    SET
      status = 'fulfilled',
      closed_at = now(),
      closed_by = v_caller_id,
      deferred_at = NULL,
      deferred_by = NULL,
      deferred_date = NULL,
      deferred_venue = NULL,
      updated_at = now()
    WHERE orders.patient_id = p_patient_id
      AND orders.kind = v_kind
      AND orders.status = 'pending'
    RETURNING orders.id INTO v_order_id;

    IF v_order_id IS NOT NULL THEN
      v_count := v_count + 1;
      CONTINUE;
    END IF;

    -- A browser retry or repeat tap after success must not manufacture a second
    -- fulfilled treatment. A cancelled order is intentionally eligible to be
    -- re-created because cancellation is an explicit reversal.
    IF EXISTS (
      SELECT 1
      FROM public.treatment_orders AS orders
      WHERE orders.patient_id = p_patient_id
        AND orders.kind = v_kind
        AND orders.status IN ('fulfilled', 'deferred')
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO public.treatment_orders (
      patient_id,
      camp_id,
      kind,
      status,
      closed_at,
      closed_by,
      updated_at
    )
    VALUES (
      p_patient_id,
      v_patient.camp_id,
      v_kind,
      'fulfilled',
      now(),
      v_caller_id,
      now()
    );

    v_count := v_count + 1;
  END LOOP;

  created_count := v_count;
  RETURN NEXT;
END;
$$;

ALTER FUNCTION public.counter_create_and_fulfill_order(uuid, text[])
  OWNER TO postgres;
REVOKE ALL
  ON FUNCTION public.counter_create_and_fulfill_order(uuid, text[])
  FROM PUBLIC, anon;
GRANT EXECUTE
  ON FUNCTION public.counter_create_and_fulfill_order(uuid, text[])
  TO authenticated, service_role, postgres;

COMMENT ON COLUMN public.treatment_orders.source IS
  'Immutable creation path: doctor (digital prescription) or counter (paper prescription).';
COMMENT ON COLUMN public.treatment_orders.created_by IS
  'Staff profile that created the treatment order; independent from closed_by.';
