-- #112: every identity field sourced from a scanned Aadhaar card is immutable.
-- Contact fields remain editable as required by the accepted workflow.

CREATE OR REPLACE FUNCTION public.enforce_person_field_locks()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
  IF OLD.aadhaar_locked_at IS NOT NULL
     AND NEW.aadhaar_last4 IS DISTINCT FROM OLD.aadhaar_last4
  THEN
    RAISE EXCEPTION 'Aadhaar field is locked and cannot be modified';
  END IF;

  IF OLD.name_locked_at IS NOT NULL
     AND NEW.full_name IS DISTINCT FROM OLD.full_name
  THEN
    RAISE EXCEPTION 'Name field is locked and cannot be modified';
  END IF;

  IF OLD.aadhaar_locked_at IS NOT NULL
     AND NEW.date_of_birth IS DISTINCT FROM OLD.date_of_birth
  THEN
    RAISE EXCEPTION 'Date of birth field is locked and cannot be modified';
  END IF;

  IF OLD.aadhaar_locked_at IS NOT NULL
     AND NEW.gender IS DISTINCT FROM OLD.gender
  THEN
    RAISE EXCEPTION 'Gender field is locked and cannot be modified';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_person_field_locks() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_person_field_locks()
  FROM PUBLIC, anon, authenticated, service_role;
