-- #25 — Staff desks subscribe to patient-row changes for the active camp.
-- Realtime only delivers rows the JWT may SELECT (RLS applies to the feed).

-- Filtered postgres_changes on camp_id need non-PK columns in the WAL row.
ALTER TABLE public.patients REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'patients'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.patients;
  END IF;
END $$;

-- Doctors are camp crew but not is_staff(); without SELECT they never receive
-- postgres_changes. They already read/mutate patients via SECURITY DEFINER
-- RPCs — active-camp SELECT for camp crew matches desk operational access.
DROP POLICY IF EXISTS "authenticated read permitted patients" ON public.patients;

CREATE POLICY "authenticated read permitted patients"
  ON public.patients
  FOR SELECT
  TO authenticated
  USING (
    (user_id = (SELECT auth.uid()))
    OR (SELECT public.is_admin())
    OR (
      (SELECT public.is_camp_crew())
      AND EXISTS (
        SELECT 1
        FROM public.camps c
        WHERE c.id = patients.camp_id
          AND c.is_active
      )
    )
  );
