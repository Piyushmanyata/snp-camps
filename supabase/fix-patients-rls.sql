-- Fix patients RLS: insert+select RETURNING failed for walk-up/anon and non-staff with null user_id
-- Also missing INSERT grant for anon

grant usage on schema public to anon, authenticated;

grant select, delete on public.patients to authenticated;
revoke insert, update on public.patients from anon, authenticated;
grant select on public.camps to anon, authenticated;

-- ensure staff helpers callable from policies
grant execute on function public.is_staff() to anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;

-- Registration is RPC-only; direct inserts bypass duplicate and queue controls.
drop policy if exists "register on active camp" on public.patients;
drop policy if exists "staff insert patients" on public.patients;
drop policy if exists "staff update patients" on public.patients;
drop policy if exists "patient update own link" on public.patients;

drop policy if exists "update own profile" on public.profiles;
drop policy if exists "update own patient profile" on public.profiles;
create policy "update own patient profile" on public.profiles
  for update
  using (id = auth.uid() or public.is_admin())
  with check (public.is_admin() or (id = auth.uid() and role = 'patient'));

-- Allow the authenticated registrant to read their own row after insert.
drop policy if exists "patient read own" on public.patients;
create policy "patient read own" on public.patients
  for select
  to authenticated
  using (user_id = auth.uid());

-- Bulletproof registration path (bypasses RLS via security definer)
create or replace function public.register_patient(
  p_camp_id uuid,
  p_full_name text,
  p_gender text default null,
  p_age integer default null,
  p_address text default null,
  p_phone text default null,
  p_email text default null,
  p_aadhaar_last4 text default null,
  p_user_id uuid default null,
  p_created_by uuid default null
)
returns table (id uuid, reg_no integer, full_name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_created_by uuid;
  v_aadhaar char(4);
begin
  if p_full_name is null or length(trim(p_full_name)) = 0 then
    raise exception 'full_name required';
  end if;

  if not exists (select 1 from public.camps c where c.id = p_camp_id and c.is_active = true) then
    raise exception 'No active camp';
  end if;

  -- only self-link user_id unless staff
  if p_user_id is not null then
    if p_user_id is distinct from auth.uid() and not public.is_staff() then
      raise exception 'Cannot register for another user';
    end if;
    v_user_id := p_user_id;
  else
    v_user_id := null;
  end if;

  if public.is_staff() then
    v_created_by := coalesce(p_created_by, auth.uid());
  else
    v_created_by := auth.uid(); -- null for anon
  end if;

  if p_aadhaar_last4 is null or length(trim(p_aadhaar_last4)) = 0 then
    v_aadhaar := null;
  else
    v_aadhaar := right(regexp_replace(p_aadhaar_last4, '\D', '', 'g'), 4);
    if v_aadhaar !~ '^[0-9]{4}$' then
      raise exception 'Invalid aadhaar last4';
    end if;
  end if;

  return query
  insert into public.patients (
    camp_id, user_id, full_name, gender, age, address, phone, email, aadhaar_last4, created_by, queue_status
  ) values (
    p_camp_id,
    v_user_id,
    trim(p_full_name),
    case when p_gender in ('M','F','O') then p_gender else null end,
    p_age,
    nullif(trim(coalesce(p_address, '')), ''),
    nullif(trim(coalesce(p_phone, '')), ''),
    nullif(trim(coalesce(p_email, '')), ''),
    v_aadhaar,
    v_created_by,
    'waiting'
  )
  returning patients.id, patients.reg_no, patients.full_name;
end;
$$;

grant execute on function public.register_patient(
  uuid, text, text, integer, text, text, text, text, uuid, uuid
) to anon, authenticated;
