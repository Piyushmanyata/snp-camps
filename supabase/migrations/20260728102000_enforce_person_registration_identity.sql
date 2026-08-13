-- Complete the accepted Person/Registration contract (#101, #111).
-- Person owns the permanent registration number. A Registration is unique
-- only within one Camp and always mirrors its Person's permanent number.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.patients
    WHERE person_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce Person identity: registrations without person_id exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.patients
    GROUP BY person_id, camp_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce Person identity: duplicate Person/Camp registrations exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.patients AS p
    JOIN public.persons AS pe ON pe.id = p.person_id
    WHERE p.reg_no IS DISTINCT FROM pe.reg_no
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce Person identity: Registration and Person numbers differ';
  END IF;
END
$$;

ALTER TABLE public.patients
  DROP CONSTRAINT IF EXISTS patients_reg_no_key;

ALTER TABLE public.patients
  ADD CONSTRAINT patients_camp_reg_no_key UNIQUE (camp_id, reg_no),
  ADD CONSTRAINT patients_person_camp_key UNIQUE (person_id, camp_id),
  ALTER COLUMN person_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS patients_person_id_idx
  ON public.patients (person_id);

CREATE OR REPLACE FUNCTION public.enforce_registration_person_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_person_reg_no integer;
BEGIN
  SELECT pe.reg_no
  INTO v_person_reg_no
  FROM public.persons AS pe
  WHERE pe.id = NEW.person_id;

  IF v_person_reg_no IS NULL THEN
    RAISE EXCEPTION 'Registration requires an existing Person'
      USING ERRCODE = '23503';
  END IF;

  NEW.reg_no := v_person_reg_no;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_registration_person_identity() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_registration_person_identity()
  FROM PUBLIC, anon, authenticated, service_role;

-- Trigger names are executed alphabetically. This deliberately follows the
-- expand-phase ensure_patient_person_id trigger, which links manual rows first.
DROP TRIGGER IF EXISTS zz_enforce_registration_person_identity_trg
  ON public.patients;
CREATE TRIGGER zz_enforce_registration_person_identity_trg
  BEFORE INSERT OR UPDATE OF person_id, reg_no
  ON public.patients
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_registration_person_identity();

CREATE OR REPLACE FUNCTION public.lookup_patient_status_token(
  p_reg_no integer,
  p_date_of_birth date
) RETURNS TABLE(status_token text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
  SELECT p.status_token
  FROM public.persons AS pe
  JOIN public.patients AS p ON p.person_id = pe.id
  JOIN public.camps AS c ON c.id = p.camp_id
  WHERE pe.reg_no = p_reg_no
    AND pe.date_of_birth = p_date_of_birth
  ORDER BY c.is_active DESC, p.created_at DESC, p.id DESC
  LIMIT 1
$$;

ALTER FUNCTION public.lookup_patient_status_token(integer, date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.lookup_patient_status_token(integer, date)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lookup_patient_status_token(integer, date)
  TO service_role;
