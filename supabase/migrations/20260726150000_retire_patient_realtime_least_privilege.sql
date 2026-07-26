-- #56 — Retire patient Realtime and restore least-privilege desk reads.
-- Rollback may reduce freshness to polling; must never restore leaking SELECT
-- policy or status_token grant to ordinary authenticated sessions.

-- 1. Remove patients from Realtime publication (product is poll-only).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'patients'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.patients;
  END IF;
END $$;

-- Replica identity FULL was only needed for filtered postgres_changes.
-- DEFAULT is enough without Realtime and is cheaper on WAL.
ALTER TABLE public.patients REPLICA IDENTITY DEFAULT;

-- 2. Restore SELECT policy: admin + active-camp staff/volunteer (not doctors).
--    Patient self-read branch kept for residual Auth rows until #59 retires them.
DROP POLICY IF EXISTS "authenticated read permitted patients" ON public.patients;

CREATE POLICY "authenticated read permitted patients"
  ON public.patients
  FOR SELECT
  TO authenticated
  USING (
    (user_id = (SELECT auth.uid()))
    OR (SELECT public.is_admin())
    OR (
      (SELECT public.is_staff())
      AND EXISTS (
        SELECT 1
        FROM public.camps c
        WHERE c.id = patients.camp_id
          AND c.is_active
      )
    )
  );

-- 3. Bearer status tokens are not selectable by ordinary authenticated sessions.
REVOKE SELECT ("status_token") ON TABLE public.patients FROM authenticated;

COMMENT ON COLUMN public.patients.status_token IS
  'Unguessable opaque token for the passwordless public status page /s/<token>. ≥128 bits entropy. Not granted to authenticated; only service_role or SECURITY DEFINER seams may read it.';

-- 4. Narrow server seam for registration SMS (staff only; never doctors).
CREATE OR REPLACE FUNCTION public.patient_registration_notify_fields(
  p_patient_id uuid
)
RETURNS TABLE (
  id uuid,
  reg_no integer,
  phone text,
  status_token text,
  venue text,
  day_date date
)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
  IF NOT public.is_staff() THEN
    RAISE EXCEPTION 'staff only';
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    p.reg_no,
    p.phone,
    p.status_token,
    c.venue,
    d.day_date
  FROM public.patients p
  LEFT JOIN public.camps c ON c.id = p.camp_id
  LEFT JOIN public.camp_days d ON d.id = p.camp_day_id
  WHERE p.id = p_patient_id;
END;
$$;

REVOKE ALL ON FUNCTION public.patient_registration_notify_fields(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.patient_registration_notify_fields(uuid)
  TO authenticated, service_role, postgres;
