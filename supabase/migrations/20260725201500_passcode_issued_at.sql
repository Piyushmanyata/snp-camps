-- Track whether a desk-slip Passcode was ever issued under the current scheme.
-- Null = never issued (legacy pre-passcode accounts, phone-OTP-only, or not yet provisioned).
-- Stores a timestamp only — never a passcode or hash (ADR 0001).

ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS passcode_issued_at timestamp with time zone;

COMMENT ON COLUMN public.patients.passcode_issued_at IS
  'When a desk-slip passcode was last successfully written to Auth. Null means never issued under the current scheme.';

-- patients uses column-level privileges for authenticated (see baseline GRANTs).
GRANT SELECT ("passcode_issued_at") ON TABLE public.patients TO authenticated;

-- Return type change requires DROP (CREATE OR REPLACE cannot widen OUT columns).
DROP FUNCTION IF EXISTS public.lookup_patient_scan(uuid, integer);

-- Expose the marker to camp-crew QR/reg lookup (volunteer desk).
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
  doctor_name text,
  passcode_issued_at timestamp with time zone
)
    LANGUAGE plpgsql SECURITY DEFINER
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
    select * into r
    from public.patients p
    where p.id = p_patient_id;
  elsif p_reg_no is not null then
    select * into r
    from public.patients p
    where p.reg_no = p_reg_no;
  else
    raise exception 'Provide patient id or reg no';
  end if;

  if r.id is null then
    raise exception 'Patient not found';
  end if;

  if not exists (
    select 1
    from public.camps c
    where c.id = r.camp_id
      and c.is_active
  ) then
    raise exception 'Patient belongs to an inactive camp';
  end if;

  if r.seen_by is not null then
    select p.full_name
    into v_doctor_name
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
    v_doctor_name,
    r.passcode_issued_at;
end;
$$;

COMMENT ON FUNCTION public.lookup_patient_scan(p_patient_id uuid, p_reg_no integer) IS
  'Camp-crew patient lookup for QR/reg scan. No side effects. QR is not for patient login.';

REVOKE ALL ON FUNCTION public.lookup_patient_scan(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_patient_scan(uuid, integer) TO authenticated, service_role;
