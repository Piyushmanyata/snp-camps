-- Drop team_lead_create_volunteer.
--
-- 20260728040000_team_lead_role.sql added it as the way a team lead staffs their
-- team, but Postgres cannot mint a Supabase Auth user. The body inserted a
-- profiles row keyed on `gen_random_uuid()` with no matching auth.users row, and
-- silently discarded its `p_password` argument — so every volunteer it "created"
-- was an orphan profile that could never sign in, and the caller was told it
-- succeeded.
--
-- Volunteer creation now goes through /api/team-lead/create-volunteer, which
-- mirrors the admin staff route: Auth admin API first, then the profile row with
-- team_lead_id, with the temporary password returned once to the caller.
--
-- Dropped rather than left in place: it is granted to `authenticated`, so any
-- team lead could still call it directly and litter profiles with orphan rows.

DROP FUNCTION IF EXISTS public.team_lead_create_volunteer(text, text, text, uuid);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'team_lead_create_volunteer'
  ) THEN
    RAISE EXCEPTION 'team_lead_create_volunteer must not remain callable';
  END IF;
END
$$;
