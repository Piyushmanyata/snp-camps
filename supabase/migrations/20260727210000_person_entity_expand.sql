-- #110 — Expand: introduce Person entity alongside Registration (patients).
-- Permanent human identity (Person) lives in public.persons.
-- Per-camp registration state remains in public.patients. Both coexist.

CREATE TABLE IF NOT EXISTS public.persons (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    reg_no integer DEFAULT nextval('public.patient_reg_no_seq'::regclass) NOT NULL UNIQUE,
    full_name text NOT NULL,
    gender text,
    date_of_birth date,
    address text,
    phone text,
    email text,
    aadhaar_last4 character(4),
    duplicate_key text UNIQUE,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT persons_aadhaar_last4_check CHECK ((aadhaar_last4 IS NULL) OR (aadhaar_last4 ~ '^[0-9]{4}$')),
    CONSTRAINT persons_gender_check CHECK ((gender = ANY (ARRAY['M'::text, 'F'::text, 'O'::text])) OR (gender IS NULL))
);

ALTER TABLE public.persons OWNER TO postgres;

-- Add person_id to patients table if not present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'patients' AND column_name = 'person_id'
  ) THEN
    ALTER TABLE public.patients ADD COLUMN person_id uuid REFERENCES public.persons(id);
  END IF;
END $$;

-- Backfill existing patients rows into persons deterministically
INSERT INTO public.persons (
  id,
  reg_no,
  full_name,
  gender,
  address,
  phone,
  email,
  aadhaar_last4,
  created_by,
  created_at
)
SELECT
  p.id,
  p.reg_no,
  p.full_name,
  p.gender,
  p.address,
  p.phone,
  p.email,
  p.aadhaar_last4,
  p.created_by,
  p.created_at
FROM public.patients p
WHERE p.person_id IS NULL
ON CONFLICT (reg_no) DO NOTHING;

UPDATE public.patients p
SET person_id = pe.id
FROM public.persons pe
WHERE p.person_id IS NULL AND p.reg_no = pe.reg_no;

-- Trigger to auto-create and link Person for new patients during Expand phase
CREATE OR REPLACE FUNCTION public.ensure_patient_person_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_person_id uuid;
BEGIN
  IF NEW.person_id IS NULL THEN
    SELECT id INTO v_person_id
    FROM public.persons
    WHERE reg_no = NEW.reg_no;

    IF v_person_id IS NULL THEN
      INSERT INTO public.persons (
        reg_no,
        full_name,
        gender,
        address,
        phone,
        email,
        aadhaar_last4,
        created_by,
        created_at
      ) VALUES (
        NEW.reg_no,
        NEW.full_name,
        NEW.gender,
        NEW.address,
        NEW.phone,
        NEW.email,
        NEW.aadhaar_last4,
        NEW.created_by,
        COALESCE(NEW.created_at, now())
      )
      ON CONFLICT (reg_no) DO UPDATE SET
        full_name = EXCLUDED.full_name
      RETURNING id INTO v_person_id;
    END IF;

    NEW.person_id := v_person_id;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.ensure_patient_person_id() OWNER TO postgres;

DROP TRIGGER IF EXISTS ensure_patient_person_id_trg ON public.patients;
CREATE TRIGGER ensure_patient_person_id_trg
  BEFORE INSERT ON public.patients
  FOR EACH ROW
  EXECUTE FUNCTION public.ensure_patient_person_id();

-- RLS & Grants for public.persons
ALTER TABLE public.persons ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.persons FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.persons TO authenticated, service_role;

DROP POLICY IF EXISTS "staff read persons" ON public.persons;
CREATE POLICY "staff read persons"
  ON public.persons
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_staff())
    OR (SELECT public.is_admin())
  );

DROP POLICY IF EXISTS "staff insert persons" ON public.persons;
CREATE POLICY "staff insert persons"
  ON public.persons
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT public.is_staff())
    OR (SELECT public.is_admin())
  );

DROP POLICY IF EXISTS "staff update persons" ON public.persons;
CREATE POLICY "staff update persons"
  ON public.persons
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT public.is_staff())
    OR (SELECT public.is_admin())
  );
