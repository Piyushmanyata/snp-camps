-- Split overloaded "staff" into two predicates (issue #10):
--   is_staff()     = admin | volunteer          (desk ops / patient management)
--   is_camp_crew() = admin | volunteer | doctor (QR scan, any camp desk role)
-- TypeScript mirrors: isStaff / isCampCrew in src/lib/roles.ts

CREATE OR REPLACE FUNCTION public.is_camp_crew() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.role in ('admin', 'volunteer', 'doctor')
      and p.disabled_at is null
  );
$$;

REVOKE ALL ON FUNCTION public.is_camp_crew() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_camp_crew() TO authenticated, service_role, postgres;

CREATE OR REPLACE FUNCTION public.lookup_patient_scan(
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
    v_doctor_name;
end;
$$;

COMMENT ON FUNCTION public.lookup_patient_scan(p_patient_id uuid, p_reg_no integer) IS
  'Camp-crew patient lookup for QR/reg scan. No side effects. QR is not for patient login.';
