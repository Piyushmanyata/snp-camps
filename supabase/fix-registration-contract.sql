-- Repair the registration RPC after historical migration-order drift.
-- The public wrapper promises a claim_token, so its implementation must return
-- the same six-column row shape. Keep this migration idempotent and apply it
-- after release-hardening.sql.

begin;

drop function if exists public.register_patient_authorized_impl(
  uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid
);

drop function if exists public.register_patient(
  uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid
);

create function public.register_patient_authorized_impl(
  p_camp_id uuid,
  p_full_name text,
  p_gender text default null,
  p_age integer default null,
  p_address text default null,
  p_phone text default null,
  p_email text default null,
  p_aadhaar_last4 text default null,
  p_user_id uuid default null,
  p_created_by uuid default null,
  p_camp_day_id uuid default null
)
returns table (
  id uuid,
  reg_no integer,
  full_name text,
  camp_day_id uuid,
  day_date date,
  claim_token text
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_request_role text;
  v_is_staff boolean;
  v_user_id uuid;
  v_created_by uuid;
  v_aadhaar char(4);
  v_name text;
  v_phone10 text;
  v_existing_reg integer;
  v_day public.camp_days%rowtype;
  v_taken integer;
  v_row public.patients%rowtype;
begin
  v_request_role := nullif(
    current_setting('request.jwt.claim.role', true),
    ''
  );
  if v_request_role not in ('anon', 'authenticated', 'service_role') then
    raise exception 'API role required';
  end if;

  v_is_staff := public.is_staff();
  if v_request_role = 'authenticated' and not v_is_staff then
    raise exception 'staff only';
  end if;

  v_name := trim(coalesce(p_full_name, ''));
  if length(v_name) = 0 then
    raise exception 'full_name required';
  end if;

  if not exists (
    select 1
    from public.camps c
    where c.id = p_camp_id
      and c.is_active = true
  ) then
    raise exception 'No active camp';
  end if;

  if p_camp_day_id is null then
    raise exception 'Please select a camp day';
  end if;

  select *
  into v_day
  from public.camp_days d
  where d.id = p_camp_day_id
  for update;

  if v_day.id is null or v_day.camp_id is distinct from p_camp_id then
    raise exception 'Invalid camp day';
  end if;

  select count(*)::int
  into v_taken
  from public.patients p
  where p.camp_day_id = p_camp_day_id;

  if v_taken >= v_day.seat_limit then
    raise exception 'This day is full (% seats). Choose another day.',
      v_day.seat_limit;
  end if;

  if p_user_id is not null then
    if v_request_role <> 'service_role'
      and p_user_id is distinct from auth.uid()
      and not v_is_staff
    then
      raise exception 'Cannot register for another user';
    end if;
    v_user_id := p_user_id;
  end if;

  if v_is_staff then
    v_created_by := coalesce(p_created_by, auth.uid());
  else
    v_created_by := auth.uid();
  end if;

  if v_request_role = 'service_role' and p_user_id is not null then
    v_created_by := null;
  end if;

  if p_aadhaar_last4 is null or length(trim(p_aadhaar_last4)) = 0 then
    v_aadhaar := null;
  else
    v_aadhaar := right(regexp_replace(p_aadhaar_last4, '\D', '', 'g'), 4);
    if v_aadhaar !~ '^[0-9]{4}$' then
      raise exception 'Invalid aadhaar last4';
    end if;
  end if;

  v_phone10 := nullif(
    right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10),
    ''
  );
  if v_phone10 is not null and length(v_phone10) < 10 then
    v_phone10 := null;
  end if;

  if v_user_id is not null then
    select p.reg_no
    into v_existing_reg
    from public.patients p
    where p.camp_id = p_camp_id
      and p.user_id = v_user_id
      and p.user_id is not null
    limit 1;
    if v_existing_reg is not null then
      raise exception
        'Already registered for this camp (reg no %). Change day instead.',
        v_existing_reg;
    end if;
  end if;

  if v_phone10 is not null then
    select p.reg_no
    into v_existing_reg
    from public.patients p
    where p.camp_id = p_camp_id
      and p.phone_normalized = v_phone10
      and length(p.phone_normalized) = 10
    limit 1;
    if v_existing_reg is not null then
      raise exception
        'Already registered for this camp with this phone (reg no %). Change day instead.',
        v_existing_reg;
    end if;
  end if;

  if v_aadhaar is not null then
    select p.reg_no
    into v_existing_reg
    from public.patients p
    where p.camp_id = p_camp_id
      and p.aadhaar_last4 = v_aadhaar
      and p.full_name_normalized = lower(v_name)
    limit 1;
    if v_existing_reg is not null then
      raise exception
        'Already registered for this camp (reg no %). Change day instead.',
        v_existing_reg;
    end if;
  end if;

  if v_phone10 is null and v_aadhaar is null and p_age is not null then
    select p.reg_no
    into v_existing_reg
    from public.patients p
    where p.camp_id = p_camp_id
      and p.full_name_normalized = lower(v_name)
      and p.age = p_age
      and p.phone_normalized is null
      and p.aadhaar_last4 is null
    limit 1;
    if v_existing_reg is not null then
      raise exception
        'Already registered for this camp (reg no %). Change day instead.',
        v_existing_reg;
    end if;
  end if;

  insert into public.patients (
    camp_id,
    camp_day_id,
    user_id,
    full_name,
    gender,
    age,
    address,
    phone,
    email,
    aadhaar_last4,
    created_by,
    queue_status,
    queued_at,
    account_claim_token,
    account_claim_expires_at
  )
  values (
    p_camp_id,
    p_camp_day_id,
    v_user_id,
    v_name,
    case when p_gender in ('M', 'F', 'O') then p_gender else null end,
    p_age,
    nullif(trim(coalesce(p_address, '')), ''),
    v_phone10,
    nullif(trim(coalesce(p_email, '')), ''),
    v_aadhaar,
    v_created_by,
    'registered',
    null,
    case
      when v_is_staff then null
      else encode(extensions.gen_random_bytes(24), 'hex')
    end,
    case
      when v_is_staff then null
      else now() + interval '30 minutes'
    end
  )
  returning
    public.patients.id,
    public.patients.reg_no,
    public.patients.full_name,
    public.patients.camp_day_id,
    public.patients.account_claim_token
  into
    v_row.id,
    v_row.reg_no,
    v_row.full_name,
    v_row.camp_day_id,
    v_row.account_claim_token;

  id := v_row.id;
  reg_no := v_row.reg_no;
  full_name := v_row.full_name;
  camp_day_id := v_row.camp_day_id;
  day_date := v_day.day_date;
  claim_token := v_row.account_claim_token;
  return next;
end;
$$;

revoke all on function public.register_patient_authorized_impl(
  uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid
) from public, anon, authenticated, service_role;

create function public.register_patient(
  p_camp_id uuid,
  p_full_name text,
  p_gender text default null,
  p_age integer default null,
  p_address text default null,
  p_phone text default null,
  p_email text default null,
  p_aadhaar_last4 text default null,
  p_user_id uuid default null,
  p_created_by uuid default null,
  p_camp_day_id uuid default null
)
returns table (
  id uuid,
  reg_no integer,
  full_name text,
  camp_day_id uuid,
  day_date date,
  claim_token text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_request_role text;
begin
  v_request_role := nullif(
    current_setting('request.jwt.claim.role', true),
    ''
  );
  if v_request_role = 'authenticated' and not public.is_staff() then
    raise exception 'staff only';
  end if;
  if v_request_role not in ('anon', 'authenticated', 'service_role') then
    raise exception 'API role required';
  end if;

  return query
  select r.*
  from public.register_patient_authorized_impl(
    p_camp_id => p_camp_id,
    p_full_name => p_full_name,
    p_gender => p_gender,
    p_age => p_age,
    p_address => p_address,
    p_phone => p_phone,
    p_email => p_email,
    p_aadhaar_last4 => p_aadhaar_last4,
    p_user_id => p_user_id,
    p_created_by => p_created_by,
    p_camp_day_id => p_camp_day_id
  ) r;
end;
$$;

revoke all on function public.register_patient(
  uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.register_patient(
  uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid
) to anon, authenticated, service_role;

commit;

notify pgrst, 'reload schema';
