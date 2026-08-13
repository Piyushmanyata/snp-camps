-- #45: passwordless status token; drop desk-slip passcode marker.
-- No production data to preserve — drop rather than expand–contract.

-- Opaque ≥128-bit URL-safe token (32 hex chars). Not derived from id or reg_no.
ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS status_token text;

UPDATE public.patients
SET status_token = encode(gen_random_bytes(16), 'hex')
WHERE status_token IS NULL;

ALTER TABLE public.patients
  ALTER COLUMN status_token SET DEFAULT encode(gen_random_bytes(16), 'hex'),
  ALTER COLUMN status_token SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS patients_status_token_uidx
  ON public.patients (status_token);

COMMENT ON COLUMN public.patients.status_token IS
  'Unguessable opaque token for the passwordless public status page /s/<token>. ≥128 bits entropy; not the patient UUID or reg number.';

GRANT SELECT ("status_token") ON TABLE public.patients TO authenticated;

-- Passcode marker no longer used (Auth patient identities removed from the product).
ALTER TABLE public.patients
  DROP COLUMN IF EXISTS passcode_issued_at;

-- lookup_patient_scan: drop passcode_issued_at from return shape.
DROP FUNCTION IF EXISTS public.lookup_patient_scan(uuid, integer);

CREATE FUNCTION public.lookup_patient_scan(
  p_patient_id uuid DEFAULT NULL::uuid,
  p_reg_no integer DEFAULT NULL::integer
) RETURNS TABLE(
  id uuid,
  reg_no integer,
  full_name text,
  queue_status public.queue_status,
  phone text,
  doctor_id uuid,
  doctor_name text
)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'pg_catalog', 'public'
AS $$
declare
  r public.patients%rowtype;
  v_caller_role public.user_role;
  v_doctor_name text;
begin
  if not public.is_camp_crew() then
    raise exception 'active camp crew only';
  end if;

  select p.role
  into v_caller_role
  from public.profiles p
  where p.id = (select auth.uid());

  if p_patient_id is not null then
    select * into r from public.patients p where p.id = p_patient_id;
  elsif p_reg_no is not null then
    select * into r from public.patients p where p.reg_no = p_reg_no;
  else
    raise exception 'Provide patient id or reg no';
  end if;

  if r.id is null then
    raise exception 'Patient not found';
  end if;

  if not exists (
    select 1 from public.camps c where c.id = r.camp_id and c.is_active
  ) then
    raise exception 'Patient belongs to an inactive camp';
  end if;

  if r.seen_by is not null then
    select p.full_name into v_doctor_name
    from public.profiles p
    where p.id = r.seen_by;
  end if;

  return query
  select
    r.id,
    r.reg_no,
    r.full_name,
    r.queue_status,
    case when v_caller_role = 'doctor' then null::text else r.phone end,
    r.seen_by,
    v_doctor_name;
end;
$$;

COMMENT ON FUNCTION public.lookup_patient_scan(p_patient_id uuid, p_reg_no integer) IS
  'Camp-crew patient lookup for QR/reg scan. No side effects. QR is not a status link.';

REVOKE ALL ON FUNCTION public.lookup_patient_scan(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_patient_scan(uuid, integer) TO authenticated, service_role;

-- Health / catalog probes that still name passcode_issued_at (keep shape checks current).
-- No app_database_contract; leave other probes to app tests.
