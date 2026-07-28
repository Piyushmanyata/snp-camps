-- `staff_person_kpis` remains the single per-person KPI contract. The former
-- two-argument overload is renamed to describe its different row shape.

CREATE OR REPLACE FUNCTION public.staff_leaderboard(
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
  v_caller_role public.user_role;
BEGIN
  SELECT profile.role
  INTO v_caller_role
  FROM public.profiles AS profile
  WHERE profile.id = auth.uid()
    AND profile.role IN ('admin', 'team_lead', 'volunteer', 'doctor')
    AND profile.disabled_at IS NULL;

  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'active camp crew required';
  END IF;

  RETURN QUERY
  WITH active_patients AS (
    SELECT patient.id, patient.created_by, patient.checked_in_by
    FROM public.patients AS patient
    WHERE patient.camp_id = p_camp_id
  ),
  active_profiles AS (
    SELECT profile.id, profile.full_name, profile.role, profile.team_lead_id
    FROM public.profiles AS profile
    WHERE profile.disabled_at IS NULL
      AND profile.role IN ('team_lead', 'volunteer')
  )
  SELECT
    staff.id,
    staff.full_name,
    staff.role,
    CASE
      WHEN staff.role = 'team_lead'::public.user_role THEN (
        SELECT count(DISTINCT patient.id)::integer
        FROM active_patients AS patient
        WHERE patient.created_by = staff.id
           OR patient.checked_in_by = staff.id
           OR patient.created_by IN (
             SELECT member.id
             FROM active_profiles AS member
             WHERE member.role = 'volunteer'::public.user_role
               AND member.team_lead_id = staff.id
           )
           OR patient.checked_in_by IN (
             SELECT member.id
             FROM active_profiles AS member
             WHERE member.role = 'volunteer'::public.user_role
               AND member.team_lead_id = staff.id
           )
      )
      ELSE (
        SELECT count(DISTINCT patient.id)::integer
        FROM active_patients AS patient
        WHERE patient.created_by = staff.id
           OR patient.checked_in_by = staff.id
      )
    END,
    staff.team_lead_id,
    CASE
      WHEN staff.role = 'team_lead'::public.user_role THEN (
        SELECT count(*)::integer
        FROM active_profiles AS member
        WHERE member.role = 'volunteer'::public.user_role
          AND member.team_lead_id = staff.id
      )
      ELSE 0
    END
  FROM active_profiles AS staff
  WHERE p_target_staff_id IS NULL OR staff.id = p_target_staff_id
  ORDER BY 4 DESC, staff.full_name ASC, staff.id ASC;
END;
$$;

ALTER FUNCTION public.staff_leaderboard(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.staff_leaderboard(uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_leaderboard(uuid, uuid)
  TO authenticated, service_role, postgres;

DROP FUNCTION IF EXISTS public.staff_person_kpis(uuid, uuid);
