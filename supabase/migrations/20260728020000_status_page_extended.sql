-- #114 — Extended status page projection
-- Adds patient_id and pending_orders to patient_status_by_token.

DROP FUNCTION IF EXISTS public.patient_status_by_token(text);

CREATE OR REPLACE FUNCTION public.patient_status_by_token(p_token text)
RETURNS TABLE (
  full_name text,
  reg_no integer,
  queue_status public.queue_status,
  queue_position integer,
  camp_name text,
  venue text,
  day_date date,
  patient_id uuid,
  pending_orders text[]
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_token text;
  v_id uuid;
  v_camp_id uuid;
  v_full_name text;
  v_reg_no integer;
  v_status public.queue_status;
  v_camp_day_id uuid;
  v_position integer;
  v_orders text[];
BEGIN
  v_token := lower(btrim(coalesce(p_token, '')));
  IF v_token = '' OR v_token !~ '^[0-9a-f]{32}$' THEN
    RETURN;
  END IF;

  SELECT
    p.id,
    p.camp_id,
    coalesce(p.display_name, p.full_name),
    p.reg_no,
    p.queue_status,
    p.camp_day_id
  INTO
    v_id,
    v_camp_id,
    v_full_name,
    v_reg_no,
    v_status,
    v_camp_day_id
  FROM public.patients p
  WHERE p.status_token = v_token;

  IF v_id IS NULL THEN
    RETURN;
  END IF;

  full_name := v_full_name;
  reg_no := v_reg_no;
  queue_status := v_status;
  patient_id := v_id;

  IF v_status = 'waiting'::public.queue_status THEN
    SELECT ranked.pos::integer
    INTO v_position
    FROM (
      SELECT
        peer.id,
        row_number() OVER (
          ORDER BY peer.queued_at ASC NULLS LAST, peer.reg_no ASC, peer.id ASC
        ) AS pos
      FROM public.patients peer
      WHERE peer.camp_id = v_camp_id
        AND peer.queue_status = 'waiting'::public.queue_status
    ) ranked
    WHERE ranked.id = v_id;

    queue_position := v_position;
  ELSE
    queue_position := NULL;
  END IF;

  SELECT c.name, coalesce(c.venue, '—')
  INTO camp_name, venue
  FROM public.camps c
  WHERE c.id = v_camp_id;

  IF camp_name IS NULL THEN
    camp_name := '—';
    venue := '—';
  END IF;

  IF v_camp_day_id IS NOT NULL THEN
    SELECT d.day_date
    INTO day_date
    FROM public.camp_days d
    WHERE d.id = v_camp_day_id;
  ELSE
    day_date := NULL;
  END IF;

  SELECT coalesce(array_agg(t.kind::text), ARRAY[]::text[])
  INTO v_orders
  FROM public.treatment_orders t
  WHERE t.patient_id = v_id AND t.status = 'pending';

  pending_orders := v_orders;

  RETURN NEXT;
END;
$$;

ALTER FUNCTION public.patient_status_by_token(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.patient_status_by_token(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.patient_status_by_token(text) TO service_role, postgres;
