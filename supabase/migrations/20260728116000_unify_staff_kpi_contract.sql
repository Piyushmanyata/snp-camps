-- #119/#120: one KPI RPC serves both per-person metrics and the two aggregate
-- leaderboards. Every path is bounded to the currently active Camp.

DROP FUNCTION public.staff_person_kpis(
  uuid, text, uuid, timestamp with time zone
);

CREATE FUNCTION public.staff_person_kpis(
  p_user_id uuid,
  p_role text,
  p_camp_id uuid DEFAULT NULL,
  p_since timestamp with time zone DEFAULT NULL,
  p_scope text DEFAULT 'person'
)
RETURNS TABLE(
  total bigint,
  today bigint,
  waiting bigint,
  seen bigint,
  label text,
  staff_id uuid,
  full_name text,
  staff_role public.user_role,
  distinct_patients integer,
  team_lead_id uuid,
  team_headcount integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_caller_id uuid := auth.uid();
  v_caller_role public.user_role;
  v_target_role public.user_role;
  v_target_team_lead_id uuid;
  v_active_camp_id uuid;
  v_since timestamp with time zone := coalesce(
    p_since,
    date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata')
      AT TIME ZONE 'Asia/Kolkata'
  );
  v_label text;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT profile.role
  INTO v_caller_role
  FROM public.profiles AS profile
  WHERE profile.id = v_caller_id
    AND profile.role IN ('admin', 'team_lead', 'volunteer', 'doctor')
    AND profile.disabled_at IS NULL;

  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'active camp crew required';
  END IF;

  SELECT camp.id
  INTO v_active_camp_id
  FROM public.camps AS camp
  WHERE camp.is_active
    AND camp.id = p_camp_id;

  IF p_scope = 'leaderboard' THEN
    IF p_user_id IS NOT NULL OR p_role IS NOT NULL THEN
      RAISE EXCEPTION 'leaderboard scope does not accept a target person';
    END IF;

    RETURN QUERY
    WITH active_profiles AS (
      SELECT
        profile.id,
        profile.full_name,
        profile.role,
        profile.team_lead_id
      FROM public.profiles AS profile
      WHERE profile.disabled_at IS NULL
        AND profile.role IN ('team_lead', 'volunteer')
    ),
    aggregate_rows AS (
      SELECT
        profile.id AS staff_id,
        profile.full_name,
        profile.role AS staff_role,
        CASE
          WHEN v_active_camp_id IS NULL THEN 0
          WHEN profile.role = 'team_lead'::public.user_role THEN (
            SELECT count(DISTINCT patient.id)::integer
            FROM public.patients AS patient
            WHERE patient.camp_id = v_active_camp_id
              AND (
                patient.created_by = profile.id
                OR patient.checked_in_by = profile.id
                OR patient.created_by IN (
                  SELECT member.id
                  FROM active_profiles AS member
                  WHERE member.role = 'volunteer'::public.user_role
                    AND member.team_lead_id = profile.id
                )
                OR patient.checked_in_by IN (
                  SELECT member.id
                  FROM active_profiles AS member
                  WHERE member.role = 'volunteer'::public.user_role
                    AND member.team_lead_id = profile.id
                )
              )
          )
          ELSE (
            SELECT count(DISTINCT patient.id)::integer
            FROM public.patients AS patient
            WHERE patient.camp_id = v_active_camp_id
              AND (
                patient.created_by = profile.id
                OR patient.checked_in_by = profile.id
              )
          )
        END AS distinct_patients,
        profile.team_lead_id,
        CASE
          WHEN profile.role = 'team_lead'::public.user_role THEN (
            SELECT count(*)::integer
            FROM active_profiles AS member
            WHERE member.role = 'volunteer'::public.user_role
              AND member.team_lead_id = profile.id
          )
          ELSE 0
        END AS team_headcount
      FROM active_profiles AS profile
    )
    SELECT
      NULL::bigint,
      NULL::bigint,
      NULL::bigint,
      NULL::bigint,
      NULL::text,
      aggregate_rows.staff_id,
      aggregate_rows.full_name,
      aggregate_rows.staff_role,
      aggregate_rows.distinct_patients,
      aggregate_rows.team_lead_id,
      aggregate_rows.team_headcount
    FROM aggregate_rows
    ORDER BY
      aggregate_rows.distinct_patients DESC,
      aggregate_rows.full_name ASC NULLS LAST,
      aggregate_rows.staff_id ASC;
    RETURN;
  END IF;

  IF p_scope <> 'person' THEN
    RAISE EXCEPTION 'invalid KPI scope';
  END IF;
  IF p_user_id IS NULL OR p_role IS NULL THEN
    RAISE EXCEPTION 'person scope requires user and role';
  END IF;

  SELECT profile.role, profile.team_lead_id
  INTO v_target_role, v_target_team_lead_id
  FROM public.profiles AS profile
  WHERE profile.id = p_user_id
    AND profile.disabled_at IS NULL
    AND profile.role IN ('team_lead', 'volunteer', 'doctor');

  IF v_target_role IS NULL OR v_target_role::text IS DISTINCT FROM p_role THEN
    RAISE EXCEPTION 'invalid KPI target';
  END IF;

  IF v_caller_role <> 'admin'
     AND v_caller_id IS DISTINCT FROM p_user_id
     AND NOT (
       v_caller_role = 'team_lead'
       AND v_target_role = 'volunteer'
       AND v_target_team_lead_id = v_caller_id
     )
  THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF v_target_role = 'doctor' THEN
    v_label := 'Patients seen';
  ELSE
    v_label := 'Patients handled';
  END IF;

  IF v_active_camp_id IS NULL THEN
    RETURN QUERY
    SELECT
      0::bigint,
      0::bigint,
      0::bigint,
      0::bigint,
      v_label,
      NULL::uuid,
      NULL::text,
      NULL::public.user_role,
      NULL::integer,
      NULL::uuid,
      NULL::integer;
    RETURN;
  END IF;

  IF v_target_role = 'doctor' THEN
    RETURN QUERY
    SELECT
      count(*)::bigint,
      count(*) FILTER (WHERE patient.seen_at >= v_since)::bigint,
      0::bigint,
      count(*)::bigint,
      v_label,
      NULL::uuid,
      NULL::text,
      NULL::public.user_role,
      NULL::integer,
      NULL::uuid,
      NULL::integer
    FROM public.patients AS patient
    WHERE patient.seen_by = p_user_id
      AND patient.queue_status = 'seen'
      AND patient.camp_id = v_active_camp_id;
  ELSIF v_target_role = 'team_lead' THEN
    RETURN QUERY
    WITH team_members AS (
      SELECT p_user_id AS member_id
      UNION
      SELECT member.id
      FROM public.profiles AS member
      WHERE member.role = 'volunteer'
        AND member.team_lead_id = p_user_id
        AND member.disabled_at IS NULL
    )
    SELECT
      count(DISTINCT patient.id)::bigint,
      count(DISTINCT patient.id) FILTER (
        WHERE (
          patient.created_by IN (SELECT member_id FROM team_members)
          AND patient.created_at >= v_since
        )
        OR (
          patient.checked_in_by IN (SELECT member_id FROM team_members)
          AND coalesce(
            patient.queued_at,
            patient.seen_at,
            patient.created_at
          ) >= v_since
        )
      )::bigint,
      count(DISTINCT patient.id) FILTER (
        WHERE patient.queue_status = 'waiting'
      )::bigint,
      count(DISTINCT patient.id) FILTER (
        WHERE patient.queue_status = 'seen'
      )::bigint,
      v_label,
      NULL::uuid,
      NULL::text,
      NULL::public.user_role,
      NULL::integer,
      NULL::uuid,
      NULL::integer
    FROM public.patients AS patient
    WHERE patient.camp_id = v_active_camp_id
      AND (
        patient.created_by IN (SELECT member_id FROM team_members)
        OR patient.checked_in_by IN (SELECT member_id FROM team_members)
      );
  ELSE
    RETURN QUERY
    SELECT
      count(*)::bigint,
      count(*) FILTER (
        WHERE (
          patient.created_by = p_user_id
          AND patient.created_at >= v_since
        )
        OR (
          patient.checked_in_by = p_user_id
          AND coalesce(
            patient.queued_at,
            patient.seen_at,
            patient.created_at
          ) >= v_since
        )
      )::bigint,
      count(*) FILTER (WHERE patient.queue_status = 'waiting')::bigint,
      count(*) FILTER (WHERE patient.queue_status = 'seen')::bigint,
      v_label,
      NULL::uuid,
      NULL::text,
      NULL::public.user_role,
      NULL::integer,
      NULL::uuid,
      NULL::integer
    FROM public.patients AS patient
    WHERE patient.camp_id = v_active_camp_id
      AND (
        patient.created_by = p_user_id
        OR patient.checked_in_by = p_user_id
      );
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.staff_person_kpis(
  uuid, text, uuid, timestamp with time zone, text
) IS
  'Single active-Camp KPI contract. person scope returns one authorized staff summary; leaderboard scope returns aggregate staff names and counts only.';

ALTER FUNCTION public.staff_person_kpis(
  uuid, text, uuid, timestamp with time zone, text
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.staff_person_kpis(
  uuid, text, uuid, timestamp with time zone, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_person_kpis(
  uuid, text, uuid, timestamp with time zone, text
) TO authenticated, service_role, postgres;

DO $migration$
BEGIN
  IF (
    SELECT count(*)
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'staff_person_kpis'
  ) <> 1
  THEN
    RAISE EXCEPTION 'KPI catalog must expose one staff_person_kpis signature only';
  END IF;
END
$migration$;
