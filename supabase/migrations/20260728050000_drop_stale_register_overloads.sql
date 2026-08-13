-- Remove the ambiguous register_patient_idempotent overload.
--
-- 20260727220000_person_scanned_registration_migration.sql deliberately kept
-- short forwarders (14, 15 and 18 arguments) that delegate to the full
-- implementation, and defined that implementation with 21 arguments.
-- 20260728000000_person_latin_display_name.sql then added p_display_name. A
-- longer parameter list is a *different* function, so CREATE OR REPLACE created
-- a 22-argument function and left the 21-argument one in place — two full
-- implementations, the older one now stale.
--
-- p_display_name carries a default, so a 21-argument call matches both and
-- Postgres refuses it with "function ... is not unique" (42725). That is what
-- broke the Person suites.
--
-- Dropping only the stale 21-argument implementation resolves it. The
-- forwarders call through positionally with 21 arguments, so they now bind to
-- the 22-argument version via that default and keep working untouched.
-- Dropping a function touches no rows, so this is safe against live camp data.

DROP FUNCTION IF EXISTS public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, boolean, text, timestamptz, text, text, text, date
);

-- Restore the EXECUTE grant. 20260728000000_person_latin_display_name.sql added
-- p_display_name, which created a *new* function rather than replacing the
-- granted 21-argument one — and it carried no GRANT. Signed-in staff call this
-- RPC as `authenticated`, so desk registration failed with
-- "permission denied for function register_patient_idempotent".
GRANT EXECUTE ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, boolean, text, timestamptz, text, text, text, date, text
) TO service_role, authenticated;

-- Fail loudly on replay if a second full implementation ever reappears, so this
-- class of drift cannot come back unnoticed. Exactly one overload may accept 21
-- or more arguments; the short forwarders are expected and allowed.
DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'register_patient_idempotent'
    AND p.pronargs >= 21;

  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'register_patient_idempotent must have exactly one full implementation, found %',
      v_count;
  END IF;
END
$$;
