-- #115 — Counter order creation RPC for paper prescription camps.
-- Allows counter operators to create and fulfill treatment orders for paper camps in one action.

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
BEGIN
  IF NOT public.is_camp_crew() THEN
    RAISE EXCEPTION 'active camp crew required';
  END IF;

  IF p_patient_id IS NULL THEN
    RAISE EXCEPTION 'patient_id is required';
  END IF;

  SELECT * INTO v_patient
  FROM public.patients p
  WHERE p.id = p_patient_id
  FOR UPDATE;

  IF v_patient.id IS NULL THEN
    RAISE EXCEPTION 'Patient not found';
  END IF;

  v_caller_id := (SELECT auth.uid());

  IF p_kinds IS NOT NULL AND array_length(p_kinds, 1) > 0 THEN
    FOREACH v_kind IN ARRAY p_kinds LOOP
      v_kind := lower(trim(v_kind));
      IF v_kind IN ('ot', 'pharmacy', 'spectacles') THEN
        INSERT INTO public.treatment_orders (
          patient_id,
          camp_id,
          kind,
          status,
          closed_at,
          closed_by,
          updated_at
        ) VALUES (
          p_patient_id,
          v_patient.camp_id,
          v_kind,
          'fulfilled',
          now(),
          v_caller_id,
          now()
        )
        ON CONFLICT (patient_id, kind) WHERE (status = 'pending')
        DO UPDATE SET
          status = 'fulfilled',
          closed_at = now(),
          closed_by = v_caller_id,
          updated_at = now();

        v_count := v_count + 1;
      END IF;
    END LOOP;
  END IF;

  created_count := v_count;
  RETURN NEXT;
END;
$$;

ALTER FUNCTION public.counter_create_and_fulfill_order(uuid, text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.counter_create_and_fulfill_order(uuid, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.counter_create_and_fulfill_order(uuid, text[]) TO authenticated, service_role, postgres;
