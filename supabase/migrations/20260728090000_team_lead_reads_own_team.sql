-- Let a team lead read the volunteers on their own team.
--
-- The baseline SELECT policy on profiles is own-row-or-admin:
--
--   USING (id = auth.uid() OR is_admin())
--
-- So a team lead's desk roster query — profiles WHERE role = 'volunteer' AND
-- team_lead_id = <lead> — was silently filtered to zero rows by RLS. No error,
-- just an empty team, which made the Team Lead panel's roster and headcount
-- read as "no volunteers" no matter how many the lead had created.
--
-- Widen the policy by exactly one case: the caller is an active team lead and
-- the row is a volunteer assigned to them. Admin and own-row are unchanged, and
-- no other role gains any visibility.

CREATE OR REPLACE FUNCTION public.is_team_lead_of(p_profile_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
  -- exists() so this is never NULL: a NULL USING clause reads as false in RLS,
  -- but the same predicate reused in a procedural guard would skip the guard
  -- (see 20260728060000_fix_role_predicates_null_safety.sql).
  select exists (
    select 1
    from public.profiles lead
    join public.profiles member on member.id = p_profile_id
    where lead.id = (select auth.uid())
      and lead.role = 'team_lead'::public.user_role
      and lead.disabled_at is null
      and member.role = 'volunteer'::public.user_role
      and member.team_lead_id = lead.id
  );
$$;

ALTER FUNCTION public.is_team_lead_of(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_team_lead_of(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_team_lead_of(uuid)
  TO authenticated, service_role, postgres;

DROP POLICY IF EXISTS "authenticated read permitted profiles" ON public.profiles;
CREATE POLICY "authenticated read permitted profiles" ON public.profiles
  FOR SELECT TO authenticated
  USING (
    id = (select auth.uid())
    OR (select public.is_admin())
    -- Correlated on purpose: the check is per candidate row, not per statement.
    OR public.is_team_lead_of(id)
  );

-- Never NULL, and never true for an unauthenticated caller.
DO $$
BEGIN
  IF public.is_team_lead_of(NULL) IS NOT FALSE THEN
    RAISE EXCEPTION 'is_team_lead_of(NULL) must be false, got %',
      coalesce(public.is_team_lead_of(NULL)::text, 'NULL');
  END IF;
  IF public.is_team_lead_of(gen_random_uuid()) IS NOT FALSE THEN
    RAISE EXCEPTION 'is_team_lead_of() must be false with no authenticated lead';
  END IF;
END
$$;
