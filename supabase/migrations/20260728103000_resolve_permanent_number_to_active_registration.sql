-- A permanent registration number can now occur once per Camp. Keep the
-- existing RPC contracts, but resolve number-based desk actions to the active
-- Camp Registration before invoking their proven implementations.

CREATE OR REPLACE FUNCTION public.active_registration_id(
  p_patient_id uuid,
  p_reg_no integer
) RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
  SELECT CASE
    WHEN p_patient_id IS NOT NULL THEN p_patient_id
    ELSE (
      SELECT p.id
      FROM public.patients AS p
      JOIN public.camps AS c ON c.id = p.camp_id
      WHERE p.reg_no = p_reg_no
        AND c.is_active
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT 1
    )
  END
$$;

ALTER FUNCTION public.active_registration_id(uuid, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.active_registration_id(uuid, integer)
  FROM PUBLIC, anon, authenticated, service_role;

ALTER FUNCTION public.lookup_patient_scan(uuid, integer)
  RENAME TO lookup_patient_scan_registration_impl;

REVOKE ALL ON FUNCTION public.lookup_patient_scan_registration_impl(uuid, integer)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.lookup_patient_scan(
  p_patient_id uuid DEFAULT NULL,
  p_reg_no integer DEFAULT NULL
) RETURNS TABLE(
  id uuid,
  reg_no integer,
  full_name text,
  queue_status public.queue_status,
  phone text,
  doctor_id uuid,
  doctor_name text,
  prescription_id uuid,
  diagnosis text,
  examination text,
  medicines text,
  advice text,
  spectacles_type text,
  destinations text[],
  is_locked boolean,
  amendments jsonb,
  theatre_capacity integer,
  theatre_reserved integer,
  theatre_remaining integer,
  ot_scheduled_day_id uuid,
  ot_scheduled_day_date date,
  next_available_ot_day_date date
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
  SELECT *
  FROM public.lookup_patient_scan_registration_impl(
    public.active_registration_id(p_patient_id, p_reg_no),
    NULL
  )
$$;

ALTER FUNCTION public.lookup_patient_scan(uuid, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.lookup_patient_scan(uuid, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lookup_patient_scan(uuid, integer)
  TO authenticated, service_role;

ALTER FUNCTION public.check_in_patient(uuid, integer)
  RENAME TO check_in_patient_registration_impl;

REVOKE ALL ON FUNCTION public.check_in_patient_registration_impl(uuid, integer)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.check_in_patient(
  p_patient_id uuid DEFAULT NULL,
  p_reg_no integer DEFAULT NULL
) RETURNS TABLE(
  id uuid,
  reg_no integer,
  full_name text,
  queue_status public.queue_status,
  already_waiting boolean,
  doctor_name text,
  error_code text
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
  SELECT *
  FROM public.check_in_patient_registration_impl(
    public.active_registration_id(p_patient_id, p_reg_no),
    NULL
  )
$$;

ALTER FUNCTION public.check_in_patient(uuid, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.check_in_patient(uuid, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_in_patient(uuid, integer)
  TO authenticated, service_role;

ALTER FUNCTION public.assign_patient_doctor(uuid, integer, uuid)
  RENAME TO assign_patient_doctor_registration_impl;

REVOKE ALL ON FUNCTION public.assign_patient_doctor_registration_impl(uuid, integer, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.assign_patient_doctor(
  p_patient_id uuid DEFAULT NULL,
  p_reg_no integer DEFAULT NULL,
  p_doctor_id uuid DEFAULT NULL
) RETURNS TABLE(
  id uuid,
  reg_no integer,
  full_name text,
  queue_status public.queue_status,
  doctor_id uuid,
  doctor_name text,
  already_seen boolean,
  error_code text
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
  SELECT *
  FROM public.assign_patient_doctor_registration_impl(
    public.active_registration_id(p_patient_id, p_reg_no),
    NULL,
    p_doctor_id
  )
$$;

ALTER FUNCTION public.assign_patient_doctor(uuid, integer, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.assign_patient_doctor(uuid, integer, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_patient_doctor(uuid, integer, uuid)
  TO authenticated, service_role;
