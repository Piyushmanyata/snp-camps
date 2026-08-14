-- ADR 0013: undo is refused once a Prescription Transcription exists.
-- clinical_save_transcription must take the same patients row lock as
-- undo_mark_seen so the two cannot both commit.

CREATE OR REPLACE FUNCTION public.clinical_save_transcription(
  p_patient_id uuid,
  p_data jsonb
)
RETURNS public.prescription_transcriptions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_row public.prescription_transcriptions;
  v_status public.queue_status;
  v_active boolean;
BEGIN
  IF NOT public.is_clinical_operator() THEN
    RAISE EXCEPTION 'clinical operator only';
  END IF;

  PERFORM public.assert_valid_clinical_data(p_data);

  SELECT p.queue_status, c.is_active
    INTO v_status, v_active
    FROM public.patients AS p
    JOIN public.camps AS c ON c.id = p.camp_id
   WHERE p.id = p_patient_id
   FOR UPDATE OF p;

  IF v_status IS DISTINCT FROM 'seen' OR v_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'patient has not been seen';
  END IF;

  INSERT INTO public.prescription_transcriptions (
    patient_id, data, created_by, updated_by
  ) VALUES (
    p_patient_id, p_data, v_actor, v_actor
  )
  ON CONFLICT (patient_id) DO UPDATE
    SET data = excluded.data,
        updated_by = v_actor,
        updated_at = now()
    WHERE public.prescription_transcriptions.locked_at IS NULL
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'transcription is locked; add a correction';
  END IF;

  RETURN v_row;
END;
$function$;

ALTER FUNCTION public.clinical_save_transcription(uuid, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.clinical_save_transcription(uuid, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clinical_save_transcription(uuid, jsonb)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.latest_applied_migration()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$ SELECT '20260814100000'::text $$;

ALTER FUNCTION public.latest_applied_migration() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.latest_applied_migration()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.latest_applied_migration()
  TO service_role, postgres;
