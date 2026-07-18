-- Follow-up corrections after production-readiness.sql.

-- The admin UI deletes through PostgREST; RLS supplies the admin-only check,
-- while the table privilege permits the operation to reach that policy.
grant delete on table public.patients to authenticated;

create or replace function public.link_patient_phone(p_phone text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone10 text;
  v_count integer;
  v_patient_id uuid;
  v_auth_phone text;
  v_phone_confirmed_at timestamptz;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
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

  select count(*)::int, min(p.id) into v_count, v_patient_id
  from public.patients p
  join public.camps c on c.id = p.camp_id and c.is_active
  where p.user_id is null
    and p.phone_normalized = v_phone10;
  if v_count = 0 then
    raise exception 'No unlinked registration was found for this phone number';
  end if;
  if v_count > 1 then
    raise exception 'Multiple registrations found; ask the desk to link your account';
  end if;

  update public.patients
  set user_id = auth.uid()
  where id = v_patient_id and user_id is null;
  if not found then raise exception 'Registration was already linked'; end if;
  return v_patient_id;
end;
$$;

revoke all on function public.link_patient_phone(text)
  from public, anon, authenticated;
grant execute on function public.link_patient_phone(text) to authenticated;
