-- Clinical records are read directly but mutated only through guarded RPCs.
-- Structural constraints also prevent cross-Camp and impossible state writes,
-- including writes made through a privileged integration.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.treatment_orders
    WHERE patient_id IS NULL
       OR camp_id IS NULL
       OR kind IS NULL
       OR status IS NULL
  ) THEN
    RAISE EXCEPTION
      'Cannot harden treatment orders: required values are missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.treatment_orders AS t
    LEFT JOIN public.patients AS p
      ON p.id = t.patient_id
     AND p.camp_id = t.camp_id
    WHERE p.id IS NULL
  ) THEN
    RAISE EXCEPTION
      'Cannot harden treatment orders: patient/Camp mismatch exists';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.treatment_orders AS t
    JOIN public.prescriptions AS pr ON pr.id = t.prescription_id
    WHERE t.prescription_id IS NOT NULL
      AND (
        pr.patient_id IS DISTINCT FROM t.patient_id
        OR pr.camp_id IS DISTINCT FROM t.camp_id
      )
  ) THEN
    RAISE EXCEPTION
      'Cannot harden treatment orders: prescription scope mismatch exists';
  END IF;
END
$$;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE
    public.prescriptions,
    public.prescription_amendments,
    public.treatment_orders
  FROM authenticated;

GRANT SELECT
  ON TABLE
    public.prescriptions,
    public.prescription_amendments,
    public.treatment_orders
  TO authenticated;

DROP POLICY IF EXISTS "staff insert prescriptions" ON public.prescriptions;
DROP POLICY IF EXISTS "staff update prescriptions" ON public.prescriptions;
DROP POLICY IF EXISTS "doctors/admins insert prescription_amendments"
  ON public.prescription_amendments;
DROP POLICY IF EXISTS "staff insert treatment_orders" ON public.treatment_orders;
DROP POLICY IF EXISTS "staff update treatment_orders" ON public.treatment_orders;
DROP POLICY IF EXISTS "staff delete treatment_orders" ON public.treatment_orders;

ALTER TABLE public.patients
  ADD CONSTRAINT patients_id_camp_id_key UNIQUE (id, camp_id);

ALTER TABLE public.prescriptions
  ADD CONSTRAINT prescriptions_id_patient_camp_key
    UNIQUE (id, patient_id, camp_id),
  ADD CONSTRAINT prescriptions_patient_camp_fkey
    FOREIGN KEY (patient_id, camp_id)
    REFERENCES public.patients (id, camp_id)
    ON DELETE RESTRICT
    NOT VALID;

ALTER TABLE public.treatment_orders
  ALTER COLUMN patient_id SET NOT NULL,
  ALTER COLUMN camp_id SET NOT NULL,
  ALTER COLUMN kind SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ADD CONSTRAINT treatment_orders_patient_camp_fkey
    FOREIGN KEY (patient_id, camp_id)
    REFERENCES public.patients (id, camp_id)
    ON DELETE RESTRICT
    NOT VALID,
  ADD CONSTRAINT treatment_orders_prescription_scope_fkey
    FOREIGN KEY (prescription_id, patient_id, camp_id)
    REFERENCES public.prescriptions (id, patient_id, camp_id)
    ON DELETE CASCADE
    NOT VALID,
  ADD CONSTRAINT treatment_orders_state_integrity_check
    CHECK (
      (
        status = 'pending'
        AND closed_at IS NULL
        AND closed_by IS NULL
        AND deferred_at IS NULL
        AND deferred_by IS NULL
        AND deferred_date IS NULL
        AND deferred_venue IS NULL
      )
      OR (
        status IN ('fulfilled', 'cancelled')
        AND closed_at IS NOT NULL
        AND closed_by IS NOT NULL
        AND deferred_at IS NULL
        AND deferred_by IS NULL
        AND deferred_date IS NULL
        AND deferred_venue IS NULL
      )
      OR (
        status = 'deferred'
        AND closed_at IS NOT NULL
        AND closed_by IS NOT NULL
        AND deferred_at IS NOT NULL
        AND deferred_by IS NOT NULL
        AND deferred_date IS NOT NULL
        AND nullif(btrim(deferred_venue), '') IS NOT NULL
      )
    )
    NOT VALID;

ALTER TABLE public.prescriptions
  VALIDATE CONSTRAINT prescriptions_patient_camp_fkey;

ALTER TABLE public.treatment_orders
  VALIDATE CONSTRAINT treatment_orders_patient_camp_fkey;
ALTER TABLE public.treatment_orders
  VALIDATE CONSTRAINT treatment_orders_prescription_scope_fkey;
ALTER TABLE public.treatment_orders
  VALIDATE CONSTRAINT treatment_orders_state_integrity_check;
