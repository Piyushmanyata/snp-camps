-- Migration: Add check_duplicate_patients RPC for soft duplicate warning at desk registration
-- Date: 2026-07-22

CREATE OR REPLACE FUNCTION public.check_duplicate_patients(
  p_camp_id uuid,
  p_full_name text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_age integer DEFAULT NULL,
  p_address text DEFAULT NULL,
  p_aadhaar_last4 text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  reg_no integer,
  full_name text,
  gender text,
  age integer,
  address text,
  phone text,
  aadhaar_last4 text,
  queue_status public.queue_status,
  created_at timestamp with time zone,
  camp_day_id uuid,
  day_date date,
  match_reasons text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_norm_phone text;
  v_norm_name text;
  v_norm_address text;
  v_norm_aadhaar text;
BEGIN
  IF p_camp_id IS NULL THEN
    RETURN;
  END IF;

  -- Normalize search inputs
  v_norm_phone := NULLIF(right(regexp_replace(COALESCE(p_phone, ''), '\D', 'g'), 10), '');
  v_norm_name := lower(trim(COALESCE(p_full_name, '')));
  v_norm_address := lower(trim(COALESCE(p_address, '')));
  v_norm_aadhaar := NULLIF(trim(COALESCE(p_aadhaar_last4, '')), '');

  IF v_norm_phone IS NULL AND (v_norm_name IS NULL OR length(v_norm_name) < 2) AND v_norm_aadhaar IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH matches AS (
    SELECT
      p.id,
      p.reg_no,
      p.full_name,
      p.gender,
      p.age,
      p.address,
      p.phone,
      p.aadhaar_last4,
      p.queue_status,
      p.created_at,
      p.camp_day_id,
      cd.day_date,
      ARRAY_REMOVE(ARRAY[
        CASE 
          WHEN v_norm_phone IS NOT NULL AND p.phone_normalized IS NOT NULL AND p.phone_normalized = v_norm_phone 
          THEN 'Phone number match (' || p.phone || ')'
          ELSE NULL 
        END,
        CASE 
          WHEN v_norm_aadhaar IS NOT NULL AND p.aadhaar_last4 IS NOT NULL AND p.aadhaar_last4 = v_norm_aadhaar 
          THEN 'Aadhaar last 4 match (' || p.aadhaar_last4 || ')'
          ELSE NULL 
        END,
        CASE 
          WHEN length(v_norm_name) >= 2 AND p.full_name_normalized IS NOT NULL AND p.full_name_normalized = v_norm_name 
               AND p_age IS NOT NULL AND p.age IS NOT NULL AND abs(p.age - p_age) <= 2
          THEN 'Name and age match (' || p.full_name || ', Age ' || p.age || ')'
          ELSE NULL 
        END,
        CASE 
          WHEN length(v_norm_name) >= 2 AND p.full_name_normalized IS NOT NULL AND p.full_name_normalized = v_norm_name 
               AND length(v_norm_address) >= 3 AND p.address IS NOT NULL 
               AND (lower(p.address) LIKE '%' || v_norm_address || '%' OR v_norm_address LIKE '%' || lower(trim(p.address)) || '%')
          THEN 'Name and address match (' || p.full_name || ')'
          ELSE NULL 
        END,
        CASE 
          WHEN length(v_norm_name) >= 3 AND p.full_name_normalized IS NOT NULL AND p.full_name_normalized = v_norm_name 
               AND (v_norm_phone IS NULL OR p.phone_normalized IS NULL OR p.phone_normalized != v_norm_phone)
               AND (p_age IS NULL OR p.age IS NULL OR abs(p.age - p_age) > 2)
          THEN 'Full name match (' || p.full_name || ')'
          ELSE NULL 
        END
      ], NULL) AS reasons
    FROM public.patients p
    LEFT JOIN public.camp_days cd ON cd.id = p.camp_day_id
    WHERE p.camp_id = p_camp_id
  )
  SELECT
    m.id,
    m.reg_no,
    m.full_name,
    m.gender,
    m.age,
    m.address,
    m.phone,
    m.aadhaar_last4,
    m.queue_status,
    m.created_at,
    m.camp_day_id,
    m.day_date,
    m.reasons AS match_reasons
  FROM matches m
  WHERE array_length(m.reasons, 1) > 0
  ORDER BY m.created_at DESC
  LIMIT 5;
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_duplicate_patients(uuid, text, text, integer, text, text) TO authenticated, service_role, anon;
