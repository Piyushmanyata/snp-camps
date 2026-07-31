-- Adversarial deep review remediation (2026-07-31)
-- Phase A: seat caps pre-reg only
-- Phase B: manual exception narrow projection; rate-limit prune amortization
-- Phase E: FCFS waiting index alignment

-- ---------------------------------------------------------------------------
-- 1. Seat caps: pre-registration / self-service only (CONTEXT)
-- Desk walk-ins for today (Asia/Kolkata) are never turned away for capacity.
-- ---------------------------------------------------------------------------
DO $migration$
DECLARE
  v_signature regprocedure := to_regprocedure(
    'public.register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean,boolean,text,text,date,text)'
  );
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  IF v_signature IS NULL THEN
    RAISE EXCEPTION 'register_patient_idempotent signature not found';
  END IF;

  SELECT pg_get_functiondef(v_signature) INTO v_definition;

  v_old := $old$  IF v_taken >= v_day.seat_limit THEN
    RAISE EXCEPTION
      'This day is full (% seats). Choose another day.',
      v_day.seat_limit;
  END IF;

  v_today := (timezone('Asia/Kolkata', now()))::date;
$old$;

  v_new := $new$  v_today := (timezone('Asia/Kolkata', now()))::date;
  -- Seat caps apply to pre-registration only (self-service or non-today days).
  -- Desk walk-ins on today are never turned away for capacity (CONTEXT).
  IF v_taken >= v_day.seat_limit
     AND (
       coalesce(p_self_service, false)
       OR v_day.day_date IS DISTINCT FROM v_today
     )
  THEN
    RAISE EXCEPTION
      'This day is full (% seats). Choose another day.',
      v_day.seat_limit;
  END IF;
$new$;

  IF position(v_old IN v_definition) = 0 THEN
    -- Already patched or body drifted — fail loud so ops notice.
    IF position(
      'Desk walk-ins on today are never turned away for capacity' IN v_definition
    ) > 0 THEN
      RAISE NOTICE 'seat-cap walk-in exemption already present';
      RETURN;
    END IF;
    RAISE EXCEPTION 'seat-cap patch site not found in register_patient_idempotent';
  END IF;

  EXECUTE replace(v_definition, v_old, v_new);
END;
$migration$;

COMMENT ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text,
  uuid, uuid, uuid, boolean, boolean, boolean, text, text, date, text
) IS
  'Idempotent registration. Seat caps enforced for self-service and future-day pre-reg only; desk walk-ins on today (Asia/Kolkata) skip capacity rejection.';

-- ---------------------------------------------------------------------------
-- 2. Manual exception: never return status_token via SELECT *
-- Same narrow projection as register_patient_idempotent success rows.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.register_manual_exception(
  uuid, uuid, uuid, text, text, text, integer, text, text, text, integer, uuid
);

CREATE OR REPLACE FUNCTION public.register_manual_exception(
  p_request_id uuid,
  p_camp_id uuid,
  p_camp_day_id uuid,
  p_full_name text,
  p_display_name text,
  p_gender text,
  p_age integer,
  p_address text,
  p_phone text,
  p_reason text,
  p_failed_scan_attempts integer,
  p_actor_id uuid
) RETURNS TABLE(
  id uuid,
  reg_no integer,
  full_name text,
  camp_day_id uuid,
  day_date date,
  queue_status public.queue_status
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  v_role public.user_role;
  v_patient_id uuid;
BEGIN
  -- Qualify column refs: RETURNS TABLE(id ...) makes bare "id" a PL/pgSQL var.
  SELECT pr.role INTO v_role
  FROM public.profiles AS pr
  WHERE pr.id = p_actor_id AND pr.disabled_at IS NULL;

  IF v_role NOT IN ('admin', 'team_lead') THEN
    RAISE EXCEPTION 'manual exception requires Team Lead or admin';
  END IF;

  IF p_failed_scan_attempts < 3
     OR nullif(btrim(p_reason), '') IS NULL
     OR p_phone !~ '^[6-9][0-9]{9}$'
     OR p_phone ~ '^([0-9])\1{9}$'
  THEN
    RAISE EXCEPTION 'invalid manual exception evidence';
  END IF;

  SELECT r.id INTO v_patient_id
  FROM public.register_patient_idempotent(
    p_request_id, p_camp_id, p_full_name, p_gender, p_age, p_address, p_phone,
    null, null, null, p_actor_id, p_camp_day_id, false, false, false,
    'self_declared', null, null, p_display_name
  ) AS r;

  UPDATE public.patients AS p SET
    provenance = 'manual_exception',
    manual_exception_actor = p_actor_id,
    manual_exception_at = now(),
    manual_exception_reason = left(btrim(p_reason), 500),
    failed_scan_attempts = p_failed_scan_attempts
  WHERE p.id = v_patient_id;

  RETURN QUERY
  SELECT
    p.id,
    p.reg_no,
    p.full_name,
    p.camp_day_id,
    d.day_date,
    p.queue_status
  FROM public.patients AS p
  JOIN public.camp_days AS d ON d.id = p.camp_day_id
  WHERE p.id = v_patient_id;
END;
$$;

REVOKE ALL ON FUNCTION public.register_manual_exception(
  uuid, uuid, uuid, text, text, text, integer, text, text, text, integer, uuid
) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_manual_exception(
  uuid, uuid, uuid, text, text, text, integer, text, text, text, integer, uuid
) TO service_role, postgres;

COMMENT ON FUNCTION public.register_manual_exception(
  uuid, uuid, uuid, text, text, text, integer, text, text, text, integer, uuid
) IS
  'Team Lead / admin manual exception registration. Returns narrow projection (id, reg_no, full_name, camp_day_id, day_date, queue_status) — never status_token.';

-- ---------------------------------------------------------------------------
-- 3. Waiting partial index ordered for FCFS (queued_at, reg_no, id)
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS public.patients_camp_waiting_queued_idx;
DROP INDEX IF EXISTS public.patients_camp_waiting_fcfs_idx;

CREATE INDEX patients_camp_waiting_fcfs_idx
  ON public.patients (camp_id, queued_at, reg_no, id)
  WHERE queue_status = 'waiting';

-- ---------------------------------------------------------------------------
-- 4. Probabilistic prune in consume_public_rate_limit (amortize DELETE cost)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consume_public_rate_limit(
  p_scope text,
  p_key_hashes text[],
  p_limit integer,
  p_window_seconds integer
) RETURNS TABLE(allowed boolean, retry_after_seconds integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
  v_window_started_at timestamp with time zone;
  v_window_interval interval;
BEGIN
  IF p_scope IS NULL
     OR p_scope !~ '^[a-z0-9-]{1,64}$'
     OR p_key_hashes IS NULL
     OR cardinality(p_key_hashes) < 1
     OR cardinality(p_key_hashes) > 4
     OR p_limit < 1
     OR p_limit > 1000
     OR p_window_seconds < 1
     OR p_window_seconds > 86400
     OR EXISTS (
       SELECT 1
       FROM unnest(p_key_hashes) AS key_hash
       WHERE key_hash !~ '^[A-Za-z0-9_-]{20,64}$'
     )
  THEN
    RAISE EXCEPTION 'Invalid public rate-limit request'
      USING ERRCODE = '22023';
  END IF;

  v_window_interval := make_interval(secs => p_window_seconds);
  v_window_started_at := date_bin(
    v_window_interval,
    v_now,
    '2000-01-01 00:00:00+00'::timestamp with time zone
  );

  -- Amortize prune work: ~10% of consumes, not every call.
  IF random() < 0.1 THEN
    DELETE FROM public.public_rate_limit_buckets
    WHERE expires_at < v_now - interval '1 hour';
  END IF;

  RETURN QUERY
  WITH distinct_keys AS (
    SELECT DISTINCT key_hash
    FROM unnest(p_key_hashes) AS key_hash
  ),
  consumed AS (
    INSERT INTO public.public_rate_limit_buckets (
      scope,
      key_hash,
      window_started_at,
      attempts,
      expires_at
    )
    SELECT
      p_scope,
      distinct_keys.key_hash,
      v_window_started_at,
      1,
      v_window_started_at + v_window_interval
    FROM distinct_keys
    ON CONFLICT (scope, key_hash, window_started_at)
    DO UPDATE SET
      attempts = public.public_rate_limit_buckets.attempts + 1,
      expires_at = EXCLUDED.expires_at
    RETURNING attempts
  )
  SELECT
    bool_and(consumed.attempts <= p_limit),
    greatest(
      1,
      ceil(extract(epoch FROM (
        v_window_started_at + v_window_interval - v_now
      )))::integer
    )
  FROM consumed;
END;
$$;

COMMENT ON FUNCTION public.consume_public_rate_limit(text, text[], integer, integer) IS
  'Atomically consumes keyed fixed-window limits; expired buckets pruned probabilistically (~10% of calls).';

-- ---------------------------------------------------------------------------
-- 5. Bump readiness_catalog_probe migration head (parity with TS contract)
-- ---------------------------------------------------------------------------
DO $migration$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef('public.readiness_catalog_probe()'::regprocedure)
    INTO v_definition;
  v_old := $old$public.latest_applied_migration() = '20260730065231'$old$;
  v_new := $new$public.latest_applied_migration() = '20260731090000'$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    IF strpos(
      v_definition,
      $already$public.latest_applied_migration() = '20260731090000'$already$
    ) > 0 THEN
      RAISE NOTICE 'readiness migration head already at 20260731090000';
      RETURN;
    END IF;
    RAISE EXCEPTION 'readiness migration head anchor not found';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END;
$migration$;
