-- Migration: 20260722030000_desk_patient_pass_and_otp_linking.sql
-- Enable OTP sign-in linking for desk-registered patients.

create or replace function public.link_patient_phone(p_phone text)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_phone10 text;
  v_count integer;
  v_patient_id uuid;
  v_auth_phone text;
  v_phone_confirmed_at timestamptz;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if not exists (
    select 1
    from public.profiles
    where id = auth.uid() and role = 'patient'
  ) then
    raise exception 'Patient account required';
  end if;

  v_phone10 := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10);
  if length(v_phone10) <> 10 then raise exception 'Valid phone required'; end if;

  select u.phone, u.phone_confirmed_at
  into v_auth_phone, v_phone_confirmed_at
  from auth.users u
  where u.id = auth.uid();

  if
    v_phone_confirmed_at is null
    or v_auth_phone is distinct from '+91' || v_phone10
  then
    raise exception 'Use the Indian phone number verified for this account';
  end if;

  select count(*)::int, (array_agg(p.id order by p.created_at desc))[1]
  into v_count, v_patient_id
  from public.patients p
  join public.camps c on c.id = p.camp_id and c.is_active
  where p.phone_normalized = v_phone10;

  if v_count = 0 then return null; end if;

  update public.patients
  set user_id = auth.uid()
  where id = v_patient_id;

  return v_patient_id;
end;
$$;

revoke all on function public.link_patient_phone(text) from public, anon;
grant execute on function public.link_patient_phone(text) to authenticated, service_role;
