CREATE TABLE IF NOT EXISTS public.ot_schedule_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  camp_id uuid NOT NULL REFERENCES public.camps(id),
  day_date date NOT NULL,
  venue text NOT NULL,
  seat_limit integer NOT NULL CHECK (seat_limit >= 0),
  UNIQUE (camp_id, day_date)
);

ALTER TABLE public.fulfilment_items
  ADD COLUMN IF NOT EXISTS ot_schedule_day_id uuid REFERENCES public.ot_schedule_days(id);

CREATE OR REPLACE FUNCTION public.upsert_ot_schedule_day(
  p_camp_id uuid,
  p_day_date date,
  p_venue text,
  p_seat_limit integer,
  p_day_id uuid DEFAULT NULL
)
RETURNS public.ot_schedule_days
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  r public.ot_schedule_days;
  v_taken integer;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only';
  END IF;
  IF p_seat_limit IS NULL OR p_seat_limit < 0 THEN
    RAISE EXCEPTION 'seat_limit must be >= 0';
  END IF;
  IF nullif(btrim(p_venue), '') IS NULL THEN
    RAISE EXCEPTION 'venue required';
  END IF;

  IF p_day_id IS NOT NULL THEN
    SELECT * INTO r FROM public.ot_schedule_days d
    WHERE d.id = p_day_id AND d.camp_id = p_camp_id
    FOR UPDATE;
    IF r.id IS NULL THEN
      RAISE EXCEPTION 'Day not found';
    END IF;
    SELECT count(*)::integer INTO v_taken
    FROM public.fulfilment_items i
    WHERE i.ot_schedule_day_id = p_day_id AND i.outcome = 'deferred';
    IF p_seat_limit < v_taken THEN
      RAISE EXCEPTION 'SEAT_LIMIT_BELOW_ASSIGNED:taken=%', v_taken;
    END IF;
    UPDATE public.ot_schedule_days
    SET day_date = p_day_date, venue = btrim(p_venue), seat_limit = p_seat_limit
    WHERE id = p_day_id
    RETURNING * INTO r;
    RETURN r;
  END IF;

  INSERT INTO public.ot_schedule_days (camp_id, day_date, venue, seat_limit)
  VALUES (p_camp_id, p_day_date, btrim(p_venue), p_seat_limit)
  ON CONFLICT (camp_id, day_date) DO UPDATE
    SET venue = excluded.venue, seat_limit = excluded.seat_limit
  RETURNING * INTO r;
  RETURN r;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_ot_schedule_day(uuid, date, text, integer, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_ot_schedule_day(uuid, date, text, integer, uuid)
  TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.clinical_resolve_item(uuid, text, text, text[]);

CREATE FUNCTION public.clinical_resolve_item(
  p_patient_id uuid,
  p_kind text,
  p_outcome text,
  p_unavailable_medicines text[] DEFAULT NULL,
  p_ot_schedule_day_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_t public.prescription_transcriptions;
  v_item public.fulfilment_items;
  v_camp public.camps%rowtype;
  v_date date;
  v_venue text;
  v_slip public.deferred_slips;
  v_data jsonb;
  v_meds text[];
  v_reason text;
  v_day public.ot_schedule_days;
  v_taken integer;
BEGIN
  IF NOT public.is_clinical_operator() THEN RAISE EXCEPTION 'clinical operator only'; END IF;
  SELECT t.* INTO v_t FROM public.prescription_transcriptions t
    JOIN public.patients p ON p.id=t.patient_id
    JOIN public.camps c ON c.id=p.camp_id
    WHERE p.id=p_patient_id AND p.queue_status='seen' AND c.is_active
    FOR UPDATE OF t;
  IF NOT FOUND THEN RAISE EXCEPTION 'seen transcription required'; END IF;
  SELECT coalesce((
    SELECT c.replacement_data FROM public.prescription_corrections c
    WHERE c.transcription_id=v_t.id AND c.correction_kind='clinical'
    ORDER BY c.created_at DESC LIMIT 1
  ), v_t.data) INTO v_data;
  IF p_kind='medicine' AND p_outcome<>'not_required'
     AND nullif(btrim(v_data->>'medicines'),'') IS NULL
     THEN RAISE EXCEPTION 'medicine detail is required for this outcome'; END IF;
  IF p_kind='specs' AND p_outcome<>'not_required'
     AND (v_data->'specs' IS NULL OR v_data->'specs'='null'::jsonb)
     THEN RAISE EXCEPTION 'Specs measurements are required for this outcome'; END IF;
  IF p_kind='ot' AND p_outcome<>'not_required'
     AND (v_data->'ot' IS NULL OR v_data->'ot'='null'::jsonb)
     THEN RAISE EXCEPTION 'OT detail is required for this outcome'; END IF;

  v_meds := NULL;
  IF p_kind='medicine' AND p_outcome='not_available' THEN
    IF p_unavailable_medicines IS NULL
       OR cardinality(p_unavailable_medicines) NOT BETWEEN 1 AND 12
    THEN
      RAISE EXCEPTION 'unavailable medicines are required for this outcome';
    END IF;
    SELECT array_agg(btrim(med)) INTO v_meds FROM unnest(p_unavailable_medicines) med;
    v_reason := array_to_string(v_meds, '; ');
  ELSIF p_unavailable_medicines IS NOT NULL THEN
    RAISE EXCEPTION 'unavailable medicines only apply to medicine not_available';
  END IF;

  INSERT INTO public.fulfilment_items(
    transcription_id, kind, outcome, resolved_by, unavailable_medicines
  )
    VALUES(v_t.id, p_kind, p_outcome, v_actor, v_meds)
  ON CONFLICT (transcription_id, kind) DO NOTHING RETURNING * INTO v_item;
  IF v_item.id IS NULL THEN
    SELECT * INTO v_item FROM public.fulfilment_items
      WHERE transcription_id=v_t.id AND kind=p_kind;
    IF v_item.outcome <> p_outcome THEN RAISE EXCEPTION 'outcome conflict'; END IF;
  ELSE
    UPDATE public.prescription_transcriptions SET locked_at=coalesce(locked_at, now())
      WHERE id=v_t.id;
    INSERT INTO public.fulfilment_events(item_id, event, to_outcome, reason, created_by)
      VALUES(v_item.id, 'resolved', p_outcome, v_reason, v_actor);
  END IF;

  IF p_outcome='deferred' THEN
    SELECT c.* INTO v_camp FROM public.camps c JOIN public.patients p ON p.camp_id=c.id
      WHERE p.id=p_patient_id;
    IF p_kind='specs' THEN
      v_date:=v_camp.spectacles_collection_date; v_venue:=v_camp.spectacles_collection_venue;
    ELSIF p_kind='ot' THEN
      IF p_ot_schedule_day_id IS NOT NULL THEN
        SELECT d.* INTO v_day
        FROM public.ot_schedule_days d
        WHERE d.id = p_ot_schedule_day_id AND d.camp_id = v_camp.id
        FOR UPDATE;
        IF v_day.id IS NULL THEN
          RAISE EXCEPTION 'OT_SCHEDULE_FULL';
        END IF;
        SELECT count(*)::integer INTO v_taken
        FROM public.fulfilment_items i
        WHERE i.ot_schedule_day_id = v_day.id
          AND i.outcome = 'deferred'
          AND i.id IS DISTINCT FROM v_item.id;
        IF v_taken >= v_day.seat_limit THEN
          RAISE EXCEPTION 'OT_SCHEDULE_FULL';
        END IF;
      ELSE
        v_day := NULL;
        FOR v_day IN
          SELECT d.* FROM public.ot_schedule_days d
          WHERE d.camp_id = v_camp.id
          ORDER BY d.day_date, d.id
          FOR UPDATE
        LOOP
          SELECT count(*)::integer INTO v_taken
          FROM public.fulfilment_items i
          WHERE i.ot_schedule_day_id = v_day.id
            AND i.outcome = 'deferred'
            AND i.id IS DISTINCT FROM v_item.id;
          EXIT WHEN v_taken < v_day.seat_limit;
        END LOOP;
        IF v_day.id IS NULL OR v_taken >= v_day.seat_limit THEN
          RAISE EXCEPTION 'OT_SCHEDULE_FULL';
        END IF;
      END IF;
      UPDATE public.fulfilment_items SET ot_schedule_day_id = v_day.id
        WHERE id = v_item.id;
      v_date := v_day.day_date;
      v_venue := v_day.venue;
    ELSE
      RAISE EXCEPTION 'medicine cannot be deferred';
    END IF;
    IF v_date IS NULL OR nullif(btrim(v_venue),'') IS NULL THEN
      RAISE EXCEPTION 'matching deferred date and venue are required';
    END IF;
    INSERT INTO public.deferred_slips(item_id, reference, version, service, date_snapshot,
      venue_snapshot, issued_by)
      VALUES(v_item.id, upper(substr(p_kind,1,1))||'-'||substr(replace(v_item.id::text,'-',''),1,10),
        1, p_kind, v_date, v_venue, v_actor)
      ON CONFLICT DO NOTHING RETURNING * INTO v_slip;
    IF v_slip.id IS NULL THEN SELECT * INTO v_slip FROM public.deferred_slips
      WHERE item_id=v_item.id AND status='active'; END IF;
  END IF;
  RETURN jsonb_build_object('item', to_jsonb(v_item), 'slip', to_jsonb(v_slip));
END;
$$;

REVOKE ALL ON FUNCTION public.clinical_resolve_item(uuid, text, text, text[], uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clinical_resolve_item(uuid, text, text, text[], uuid)
  TO authenticated, service_role, postgres;

CREATE OR REPLACE FUNCTION public.latest_applied_migration()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$ SELECT '20260816230000'::text $$;
