-- Restore boolean-safe role predicates.
--
-- The baseline defined is_staff() as `select exists (...)`, which always yields
-- true or false. 20260728040000_team_lead_role.sql rewrote is_staff() and
-- is_camp_crew() in plpgsql as:
--
--   SELECT p.role INTO v_role FROM profiles WHERE id = auth.uid()
--                                             AND disabled_at IS NULL;
--   RETURN v_role IN ('admin', 'team_lead', 'volunteer');
--
-- For a disabled account — or any caller with no profile row — the SELECT sets
-- no row, v_role stays NULL, and `NULL IN (...)` is NULL, so the function
-- returns NULL rather than false.
--
-- RLS treats a NULL USING clause as false, so policies held. Procedural guards
-- did not: `if not public.is_staff() then raise exception` evaluates
-- `not NULL` = NULL, the branch is skipped, and the body runs. Nine functions
-- guard this way — camp_queue_counts, mark_patient_printed,
-- search_registered_patients, check_in_patient,
-- patient_registration_notify_fields, change_camp_day, lookup_patient_scan,
-- resolve_treatment_order and counter_create_and_fulfill_order — so a disabled
-- volunteer kept full desk and counter capability.
--
-- Back to the exists() form: same role set (admin, team_lead, volunteer, and
-- doctor for camp crew), same disabled_at rule, but never NULL.

CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.role in ('admin'::public.user_role,
                     'team_lead'::public.user_role,
                     'volunteer'::public.user_role)
      and p.disabled_at is null
  );
$$;

CREATE OR REPLACE FUNCTION public.is_camp_crew()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.role in ('admin'::public.user_role,
                     'team_lead'::public.user_role,
                     'volunteer'::public.user_role,
                     'doctor'::public.user_role)
      and p.disabled_at is null
  );
$$;

ALTER FUNCTION public.is_staff() OWNER TO postgres;
ALTER FUNCTION public.is_camp_crew() OWNER TO postgres;

-- Neither predicate may ever return NULL again: with no authenticated user
-- (auth.uid() is null) both must be exactly false.
DO $$
BEGIN
  IF public.is_staff() IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'is_staff() must return false, not %', public.is_staff();
  END IF;
  IF public.is_camp_crew() IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'is_camp_crew() must return false, not %', public.is_camp_crew();
  END IF;
END
$$;
