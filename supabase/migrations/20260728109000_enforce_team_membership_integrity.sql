-- Team membership is an explicit, indexed relationship. Only active Team Leads
-- can own volunteers; disabling a lead releases their volunteers for reassignment.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.profiles AS member
    LEFT JOIN public.profiles AS lead ON lead.id = member.team_lead_id
    WHERE member.team_lead_id IS NOT NULL
      AND (
        member.role <> 'volunteer'::public.user_role
        OR lead.id IS NULL
        OR lead.role <> 'team_lead'::public.user_role
        OR lead.disabled_at IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'Cannot enforce team membership: invalid existing assignment';
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS profiles_team_lead_id_idx
  ON public.profiles (team_lead_id)
  WHERE team_lead_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.validate_profile_team_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
  IF NEW.team_lead_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.role <> 'volunteer'::public.user_role THEN
    RAISE EXCEPTION 'only volunteers can belong to a Team Lead';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles AS lead
    WHERE lead.id = NEW.team_lead_id
      AND lead.role = 'team_lead'::public.user_role
      AND lead.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'active Team Lead required';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_profile_team_membership
  ON public.profiles;
CREATE TRIGGER validate_profile_team_membership
BEFORE INSERT OR UPDATE OF role, team_lead_id
ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.validate_profile_team_membership();

CREATE OR REPLACE FUNCTION public.release_disabled_team_members()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
  IF NEW.role = 'team_lead'::public.user_role
     AND OLD.disabled_at IS NULL
     AND NEW.disabled_at IS NOT NULL
  THEN
    UPDATE public.profiles
    SET team_lead_id = NULL
    WHERE team_lead_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS release_disabled_team_members
  ON public.profiles;
CREATE TRIGGER release_disabled_team_members
AFTER UPDATE OF disabled_at
ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.release_disabled_team_members();

REVOKE ALL ON FUNCTION public.validate_profile_team_membership() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_disabled_team_members() FROM PUBLIC;
