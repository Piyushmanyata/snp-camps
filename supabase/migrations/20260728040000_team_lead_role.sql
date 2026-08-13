-- #117, #118, #119, #120, #121 — Team Lead role, team membership, KPIs, and leaderboards

-- 1. Add team_lead to user_role enum
ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'team_lead' AFTER 'admin';

-- 2. Add team_lead_id column to profiles for volunteer team assignment
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'team_lead_id'
  ) THEN
    ALTER TABLE public.profiles ADD COLUMN team_lead_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 3. Update SQL role predicates: is_staff() and is_camp_crew()
CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_role public.user_role;
BEGIN
  SELECT p.role INTO v_role
  FROM public.profiles p
  WHERE p.id = (SELECT auth.uid())
    AND p.disabled_at IS NULL;

  RETURN v_role IN ('admin'::public.user_role, 'team_lead'::public.user_role, 'volunteer'::public.user_role);
END;
$$;

CREATE OR REPLACE FUNCTION public.is_camp_crew()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_role public.user_role;
BEGIN
  SELECT p.role INTO v_role
  FROM public.profiles p
  WHERE p.id = (SELECT auth.uid())
    AND p.disabled_at IS NULL;

  RETURN v_role IN ('admin'::public.user_role, 'team_lead'::public.user_role, 'volunteer'::public.user_role, 'doctor'::public.user_role);
END;
$$;

ALTER FUNCTION public.is_staff() OWNER TO postgres;
ALTER FUNCTION public.is_camp_crew() OWNER TO postgres;

-- 4. Stored Procedure for Team Leads creating volunteers (Ticket #118)
CREATE OR REPLACE FUNCTION public.team_lead_create_volunteer(
  p_email text,
  p_password text,
  p_full_name text,
  p_team_lead_id uuid DEFAULT NULL
)
RETURNS TABLE (
  user_id uuid,
  email text,
  role public.user_role,
  full_name text,
  team_lead_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_caller_id uuid;
  v_caller_role public.user_role;
  v_assigned_lead uuid;
  v_new_id uuid;
BEGIN
  v_caller_id := (SELECT auth.uid());

  SELECT p.role INTO v_caller_role
  FROM public.profiles p
  WHERE p.id = v_caller_id AND p.disabled_at IS NULL;

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin'::public.user_role, 'team_lead'::public.user_role) THEN
    RAISE EXCEPTION 'Only Team Leads and admins can create volunteers';
  END IF;

  IF v_caller_role = 'team_lead'::public.user_role THEN
    -- Team Leads can ONLY create volunteers assigned to their OWN team!
    v_assigned_lead := v_caller_id;
  ELSE
    -- Admin can assign any team lead or leave unassigned
    v_assigned_lead := p_team_lead_id;
  END IF;

  v_new_id := gen_random_uuid();

  -- Insert profile
  INSERT INTO public.profiles (id, role, full_name, email, team_lead_id)
  VALUES (v_new_id, 'volunteer'::public.user_role, trim(p_full_name), lower(trim(p_email)), v_assigned_lead);

  RETURN QUERY
  SELECT v_new_id, lower(trim(p_email)), 'volunteer'::public.user_role, trim(p_full_name), v_assigned_lead;
END;
$$;

ALTER FUNCTION public.team_lead_create_volunteer(text, text, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.team_lead_create_volunteer(text, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_lead_create_volunteer(text, text, text, uuid) TO authenticated, service_role, postgres;

-- 5. Extended KPI Function for Distinct Patients Handled (Ticket #119)
CREATE OR REPLACE FUNCTION public.staff_person_kpis(
  p_camp_id uuid,
  p_target_staff_id uuid DEFAULT NULL
)
RETURNS TABLE (
  staff_id uuid,
  full_name text,
  role public.user_role,
  distinct_patients integer,
  team_lead_id uuid,
  team_headcount integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_caller_id uuid;
  v_caller_role public.user_role;
BEGIN
  v_caller_id := (SELECT auth.uid());

  SELECT p.role INTO v_caller_role
  FROM public.profiles p
  WHERE p.id = v_caller_id AND p.disabled_at IS NULL;

  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'authenticated staff required';
  END IF;

  RETURN QUERY
  WITH active_patients AS (
    SELECT id, created_by, checked_in_by
    FROM public.patients
    WHERE camp_id = p_camp_id
  ),
  team_members AS (
    SELECT
      p.id AS member_id,
      COALESCE(p.team_lead_id, p.id) AS lead_id,
      p.role AS member_role
    FROM public.profiles p
    WHERE p.disabled_at IS NULL
  )
  SELECT
    pr.id AS staff_id,
    pr.full_name,
    pr.role,
    (
      CASE
        WHEN pr.role = 'team_lead'::public.user_role THEN
          (
            SELECT COUNT(DISTINCT ap.id)::integer
            FROM active_patients ap
            WHERE ap.created_by IN (SELECT m.member_id FROM team_members m WHERE m.lead_id = pr.id)
               OR ap.checked_in_by IN (SELECT m.member_id FROM team_members m WHERE m.lead_id = pr.id)
          )
        ELSE
          (
            SELECT COUNT(DISTINCT ap.id)::integer
            FROM active_patients ap
            WHERE ap.created_by = pr.id OR ap.checked_in_by = pr.id
          )
      END
    ) AS distinct_patients,
    pr.team_lead_id,
    (
      CASE
        WHEN pr.role = 'team_lead'::public.user_role THEN
          (SELECT COUNT(*)::integer FROM public.profiles tm WHERE tm.team_lead_id = pr.id AND tm.disabled_at IS NULL)
        ELSE
          0
      END
    ) AS team_headcount
  FROM public.profiles pr
  WHERE pr.disabled_at IS NULL
    AND (p_target_staff_id IS NULL OR pr.id = p_target_staff_id)
  ORDER BY distinct_patients DESC, pr.full_name ASC;
END;
$$;

ALTER FUNCTION public.staff_person_kpis(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.staff_person_kpis(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_person_kpis(uuid, uuid) TO authenticated, service_role, postgres;
