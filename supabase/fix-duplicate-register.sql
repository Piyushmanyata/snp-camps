-- Prevent the same patient registering twice on the same camp.
-- Match keys (in order): phone (last 10 digits), aadhaar last4 + name, linked user_id,
-- fallback name + age when no phone/aadhaar.

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
  v_name text;
  v_phone text;
  v_phone10 text;
  v_existing_reg integer;
begin
  v_name := trim(coalesce(p_full_name, ''));
  if length(v_name) = 0 then
    raise exception 'full_name required';
  end if;

  if not exists (select 1 from public.camps c where c.id = p_camp_id and c.is_active = true) then
    raise exception 'No active camp';
  end if;

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
    v_created_by := auth.uid();
  end if;

  if p_aadhaar_last4 is null or length(trim(p_aadhaar_last4)) = 0 then
    v_aadhaar := null;
  else
    v_aadhaar := right(regexp_replace(p_aadhaar_last4, '\D', '', 'g'), 4);
    if v_aadhaar !~ '^[0-9]{4}$' then
      raise exception 'Invalid aadhaar last4';
    end if;
  end if;

  v_phone := nullif(trim(coalesce(p_phone, '')), '');
  v_phone10 := nullif(right(regexp_replace(coalesce(v_phone, ''), '\D', '', 'g'), 10), '');
  if v_phone10 is not null and length(v_phone10) < 10 then
    v_phone10 := null;
  end if;

  -- 1) Same linked user already on this camp
  if v_user_id is not null then
    select p.reg_no into v_existing_reg
    from public.patients p
    where p.camp_id = p_camp_id and p.user_id = v_user_id
    limit 1;
    if v_existing_reg is not null then
      raise exception 'Already registered for this camp (reg no %).', v_existing_reg;
    end if;
  end if;

  -- 2) Same phone (last 10 digits) on this camp
  if v_phone10 is not null then
    select p.reg_no into v_existing_reg
    from public.patients p
    where p.camp_id = p_camp_id
      and right(regexp_replace(coalesce(p.phone, ''), '\D', '', 'g'), 10) = v_phone10
    limit 1;
    if v_existing_reg is not null then
      raise exception 'Already registered for this camp with this phone (reg no %).', v_existing_reg;
    end if;
  end if;

  -- 3) Same Aadhaar last4 + name on this camp
  if v_aadhaar is not null then
    select p.reg_no into v_existing_reg
    from public.patients p
    where p.camp_id = p_camp_id
      and p.aadhaar_last4 = v_aadhaar
      and lower(trim(p.full_name)) = lower(v_name)
    limit 1;
    if v_existing_reg is not null then
      raise exception 'Already registered for this camp (same name + Aadhaar last 4, reg no %).', v_existing_reg;
    end if;
  end if;

  -- 4) Fallback when no phone/aadhaar: same name + age on this camp
  if v_phone10 is null and v_aadhaar is null and p_age is not null then
    select p.reg_no into v_existing_reg
    from public.patients p
    where p.camp_id = p_camp_id
      and lower(trim(p.full_name)) = lower(v_name)
      and p.age = p_age
    limit 1;
    if v_existing_reg is not null then
      raise exception 'Already registered for this camp (same name + age, reg no %).', v_existing_reg;
    end if;
  end if;

  return query
  insert into public.patients (
    camp_id, user_id, full_name, gender, age, address, phone, email, aadhaar_last4, created_by, queue_status
  ) values (
    p_camp_id,
    v_user_id,
    v_name,
    case when p_gender in ('M','F','O') then p_gender else null end,
    p_age,
    nullif(trim(coalesce(p_address, '')), ''),
    v_phone,
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
