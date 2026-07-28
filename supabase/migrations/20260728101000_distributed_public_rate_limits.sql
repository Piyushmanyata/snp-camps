-- Durable fixed-window throttling for public server routes.
-- Callers send only one-way keyed identifiers; raw addresses and patient
-- details are never stored in this table.

CREATE TABLE public.public_rate_limit_buckets (
  scope text NOT NULL,
  key_hash text NOT NULL,
  window_started_at timestamp with time zone NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0),
  expires_at timestamp with time zone NOT NULL,
  PRIMARY KEY (scope, key_hash, window_started_at)
);

ALTER TABLE public.public_rate_limit_buckets OWNER TO postgres;
ALTER TABLE public.public_rate_limit_buckets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.public_rate_limit_buckets
  FROM PUBLIC, anon, authenticated, service_role;

CREATE INDEX public_rate_limit_buckets_expiry_idx
  ON public.public_rate_limit_buckets (expires_at);

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

  -- This is bounded by the expiry index and keeps the table self-pruning
  -- without requiring an additional production scheduler.
  DELETE FROM public.public_rate_limit_buckets
  WHERE expires_at < v_now - interval '1 hour';

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

ALTER FUNCTION public.consume_public_rate_limit(text, text[], integer, integer)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.consume_public_rate_limit(text, text[], integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_public_rate_limit(text, text[], integer, integer)
  TO service_role;

COMMENT ON FUNCTION public.consume_public_rate_limit(text, text[], integer, integer) IS
  'Atomically consumes keyed fixed-window limits for trusted public-route handlers.';
