-- #111 — Migrate scanned registration to Person with global one-Person-per-Aadhaar.
-- Scanned card registration passes p_duplicate_key and p_date_of_birth.
-- Global identity lives on public.persons keyed by duplicate_key.

-- Main 21-parameter function
CREATE OR REPLACE FUNCTION public.register_patient_idempotent(
  p_request_id uuid,
  p_camp_id uuid,
  p_full_name text,
  p_gender text,
  p_age integer,
  p_address text,
  p_phone text,
  p_email text,
  p_aadhaar_last4 text,
  p_user_id uuid,
  p_created_by uuid,
  p_camp_day_id uuid,
  p_aadhaar_duplicate_override boolean,
  p_likely_duplicate_override boolean,
  p_self_service boolean,
  p_aadhaar_hash text,
  p_aadhaar_verified_at timestamp with time zone,
  p_aadhaar_kyc_ref text,
  p_provenance text,
  p_duplicate_key text,
  p_date_of_birth date
) RETURNS TABLE(
  id uuid,
  reg_no integer,
  full_name text,
  camp_day_id uuid,
  day_date date,
  queue_status public.queue_status
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_request_role text;
  v_created_by uuid;
  v_aadhaar char(4);
  v_name text;
  v_name_norm text;
  v_phone10 text;
  v_conflict_reg integer;
  v_soft_reg integer;
  v_day public.camp_days%rowtype;
  v_taken integer;
  v_row public.patients%rowtype;
  v_override boolean := coalesce(p_aadhaar_duplicate_override, false);
  v_likely_override boolean := coalesce(p_likely_duplicate_override, false);
  v_override_by uuid;
  v_override_at timestamptz;
  v_likely_by uuid;
  v_likely_at timestamptz;
  v_today date;
  v_is_walkin boolean;
  v_status public.queue_status;
  v_queued_at timestamptz;
  v_checked_in_by uuid;
  v_soft_lock_keys text[] := array[]::text[];
  v_soft_lock text;
  v_person_id uuid;
  v_person_reg_no integer;
  v_patient_reg_no integer;
  v_is_new_person boolean := false;
  v_out_id uuid;
  v_out_reg_no integer;
  v_out_full_name text;
  v_out_camp_day_id uuid;
  v_out_day_date date;
  v_out_queue_status public.queue_status;
begin
  if p_request_id is null then
    raise exception 'registration request id required';
  end if;

  v_request_role := coalesce(
    nullif(auth.role(), ''),
    nullif(current_setting('request.jwt.claim.role', true), '')
  );

  if v_request_role = 'service_role' then
    v_created_by := p_created_by;
    if v_override then
      raise exception 'Aadhaar duplicate override requires staff sign-in';
    end if;
    if v_likely_override then
      raise exception 'Likely-duplicate override requires staff sign-in';
    end if;
  elsif v_request_role = 'authenticated' then
    if not exists (
      select 1
      from public.profiles p
      where p.id = (select auth.uid())
        and p.role in ('admin', 'volunteer')
        and p.disabled_at is null
    ) then
      raise exception 'active admin or volunteer required';
    end if;
    v_created_by := (select auth.uid());
  else
    raise exception 'authenticated registration required';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('register-request:' || p_request_id::text)
  );

  select p.id, p.reg_no, p.full_name, p.camp_day_id, d.day_date, p.queue_status
  into v_out_id, v_out_reg_no, v_out_full_name, v_out_camp_day_id, v_out_day_date, v_out_queue_status
  from public.patients p
  left join public.camp_days d on d.id = p.camp_day_id
  where p.registration_request_id = p_request_id;

  if found then
    id := v_out_id;
    reg_no := v_out_reg_no;
    full_name := v_out_full_name;
    camp_day_id := v_out_camp_day_id;
    day_date := v_out_day_date;
    queue_status := v_out_queue_status;
    return next;
    return;
  end if;

  v_name := trim(coalesce(p_full_name, ''));
  if length(v_name) = 0 or length(v_name) > 120 then
    raise exception 'full_name required and must be at most 120 characters';
  end if;
  v_name_norm := lower(btrim(regexp_replace(v_name, '\s+', ' ', 'g')));
  if p_age is not null and (p_age < 0 or p_age >= 150) then
    raise exception 'age must be between 0 and 149';
  end if;

  if not exists (
    select 1
    from public.camps c
    where c.id = p_camp_id and c.is_active
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

  select count(*)::integer
  into v_taken
  from public.patients p
  where p.camp_day_id = p_camp_day_id;

  if v_taken >= v_day.seat_limit then
    raise exception 'This day is full (% seats). Choose another day.', v_day.seat_limit;
  end if;

  if p_aadhaar_last4 is null or length(trim(p_aadhaar_last4)) = 0 then
    v_aadhaar := null;
  else
    v_aadhaar := right(regexp_replace(p_aadhaar_last4, '\D', '', 'g'), 4);
    if v_aadhaar !~ '^[0-9]{4}$' then
      raise exception 'Invalid aadhaar last4';
    end if;
  end if;

  if coalesce(p_self_service, false) and v_aadhaar is null then
    raise exception 'Aadhaar last4 required for self-service registration';
  end if;

  v_phone10 := nullif(
    right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10),
    ''
  );
  if v_phone10 is not null and length(v_phone10) < 10 then
    v_phone10 := null;
  end if;

  if coalesce(p_self_service, false) and p_aadhaar_hash is not null then
    perform pg_advisory_xact_lock(
      hashtext('snp-reg-aadhaar'),
      hashtext(p_camp_id::text || ':' || p_aadhaar_hash)
    );

    select p.id, p.reg_no, p.full_name, p.camp_day_id, d.day_date, p.queue_status
    into v_out_id, v_out_reg_no, v_out_full_name, v_out_camp_day_id, v_out_day_date, v_out_queue_status
    from public.patients p
    left join public.camp_days d on d.id = p.camp_day_id
    where p.camp_id = p_camp_id
      and p.aadhaar_hash = p_aadhaar_hash
      and p.aadhaar_verified_at is not null
      and p.created_by is null
    order by p.reg_no
    limit 1;

    if found then
      id := v_out_id;
      reg_no := v_out_reg_no;
      full_name := v_out_full_name;
      camp_day_id := v_out_camp_day_id;
      day_date := v_out_day_date;
      queue_status := v_out_queue_status;
      return next;
      return;
    end if;
  end if;

  v_today := (timezone('Asia/Kolkata', now()))::date;
  v_is_walkin := (v_day.day_date = v_today) and not coalesce(p_self_service, false);
  if v_is_walkin then
    v_status := 'waiting';
    v_queued_at := now();
    v_checked_in_by := coalesce((select auth.uid()), v_created_by);
  else
    v_status := 'registered';
    v_queued_at := null;
    v_checked_in_by := null;
  end if;

  -- ---------------------------------------------------------------------------
  -- Scanned Aadhaar Card Path (p_duplicate_key is provided)
  -- ---------------------------------------------------------------------------
  if p_duplicate_key is not null and length(trim(p_duplicate_key)) > 0 then
    perform pg_advisory_xact_lock(
      hashtext('person-duplicate-key:' || p_duplicate_key)
    );

    select pe.id, pe.reg_no
    into v_person_id, v_person_reg_no
    from public.persons pe
    where pe.duplicate_key = p_duplicate_key;

    if v_person_id is not null then
      -- Person exists! Check if registered in THIS camp.
      select p.id, p.reg_no, p.full_name, p.camp_day_id, d.day_date, p.queue_status
      into v_out_id, v_out_reg_no, v_out_full_name, v_out_camp_day_id, v_out_day_date, v_out_queue_status
      from public.patients p
      join public.camp_days d on d.id = p.camp_day_id
      where p.camp_id = p_camp_id and p.person_id = v_person_id
      limit 1;

      if found then
        -- Return existing Registration for this camp (check-in / duplicate return)
        id := v_out_id;
        reg_no := v_out_reg_no;
        full_name := v_out_full_name;
        camp_day_id := v_out_camp_day_id;
        day_date := v_out_day_date;
        queue_status := v_out_queue_status;
        return next;
        return;
      end if;
      -- Person attended a previous camp: reuse v_person_id
    else
      -- New Person: create in persons table
      v_is_new_person := true;
      insert into public.persons (
        reg_no,
        full_name,
        gender,
        date_of_birth,
        address,
        phone,
        email,
        aadhaar_last4,
        duplicate_key,
        created_by,
        created_at
      ) values (
        nextval('public.patient_reg_no_seq'::regclass),
        v_name,
        case when p_gender in ('M', 'F', 'O') then p_gender else null end,
        p_date_of_birth,
        nullif(trim(coalesce(p_address, '')), ''),
        v_phone10,
        nullif(trim(coalesce(p_email, '')), ''),
        v_aadhaar,
        p_duplicate_key,
        v_created_by,
        now()
      )
      returning public.persons.id, public.persons.reg_no into v_person_id, v_person_reg_no;
    end if;

  else
    -- ---------------------------------------------------------------------------
    -- Manual Registration Path (no p_duplicate_key)
    -- ---------------------------------------------------------------------------
    if p_age is not null then
      v_soft_lock_keys := array_append(
        v_soft_lock_keys,
        'name-age:' || p_camp_id::text || ':' || v_name_norm || ':' || p_age::text
      );
    end if;
    if v_phone10 is not null then
      v_soft_lock_keys := array_append(
        v_soft_lock_keys,
        'phone:' || p_camp_id::text || ':' || v_phone10
      );
    end if;

    if coalesce(array_length(v_soft_lock_keys, 1), 0) > 0 then
      select coalesce(array_agg(k order by k), array[]::text[])
      into v_soft_lock_keys
      from unnest(v_soft_lock_keys) as k;

      foreach v_soft_lock in array v_soft_lock_keys
      loop
        perform pg_advisory_xact_lock(
          hashtext('snp-reg-likely-dup'),
          hashtext(v_soft_lock)
        );
      end loop;
    end if;

    select p.reg_no
    into v_soft_reg
    from public.patients p
    where p.camp_id = p_camp_id
      and (
        (
          p_age is not null
          and p.age is not null
          and p.full_name_normalized = v_name_norm
          and p.age = p_age
        )
        or (
          v_phone10 is not null
          and p.phone_normalized is not null
          and p.phone_normalized = v_phone10
        )
      )
    order by p.reg_no
    limit 1;

    if v_soft_reg is not null then
      if not v_likely_override then
        raise exception 'LIKELY_DUPLICATE:reg=%', v_soft_reg;
      end if;
      if v_request_role is distinct from 'authenticated' then
        raise exception 'Likely-duplicate override requires staff sign-in';
      end if;
      v_likely_by := (select auth.uid());
      v_likely_at := now();
    end if;

    if v_aadhaar is not null then
      select p.reg_no
      into v_conflict_reg
      from public.patients p
      where p.camp_id = p_camp_id
        and p.aadhaar_last4 = v_aadhaar
        and p.full_name_normalized = v_name_norm
        and p.aadhaar_duplicate_override_at is null
      limit 1;

      if v_conflict_reg is not null then
        if not v_override then
          raise exception 'AADHAAR_DUPLICATE:reg=%', v_conflict_reg;
        end if;
        if v_request_role is distinct from 'authenticated' then
          raise exception 'Aadhaar duplicate override requires staff sign-in';
        end if;
        v_override_by := (select auth.uid());
        v_override_at := now();
      end if;
    end if;
  end if;

  if v_is_new_person then
    v_patient_reg_no := v_person_reg_no;
  else
    v_patient_reg_no := nextval('public.patient_reg_no_seq'::regclass);
  end if;

  insert into public.patients (
    registration_request_id,
    camp_id,
    camp_day_id,
    person_id,
    reg_no,
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
    checked_in_by,
    aadhaar_duplicate_override_by,
    aadhaar_duplicate_override_at,
    likely_duplicate_override_by,
    likely_duplicate_override_at,
    aadhaar_hash,
    aadhaar_verified_at,
    aadhaar_kyc_ref,
    provenance
  )
  values (
    p_request_id,
    p_camp_id,
    p_camp_day_id,
    v_person_id,
    v_patient_reg_no,
    v_name,
    case when p_gender in ('M', 'F', 'O') then p_gender else null end,
    p_age,
    nullif(trim(coalesce(p_address, '')), ''),
    v_phone10,
    nullif(trim(coalesce(p_email, '')), ''),
    v_aadhaar,
    v_created_by,
    v_status,
    v_queued_at,
    v_checked_in_by,
    v_override_by,
    v_override_at,
    v_likely_by,
    v_likely_at,
    p_aadhaar_hash,
    p_aadhaar_verified_at,
    p_aadhaar_kyc_ref,
    coalesce(p_provenance, 'self_declared')
  )
  returning public.patients.* into v_row;

  if v_phone10 is not null then
    insert into public.sms_deliveries (patient_id, kind, state, phone_last4)
    values (v_row.id, 'registration', 'pending', right(v_phone10, 4)::char(4))
    on conflict (patient_id, kind) do nothing;
  end if;

  id := v_row.id;
  reg_no := v_row.reg_no;
  full_name := v_row.full_name;
  camp_day_id := v_row.camp_day_id;
  day_date := v_day.day_date;
  queue_status := v_row.queue_status;
  return next;
end;
$function$;

GRANT EXECUTE ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, boolean, text, timestamptz, text, text, text, date
) TO service_role, authenticated;

-- 19-parameter forwarder
CREATE OR REPLACE FUNCTION public.register_patient_idempotent(
  p_request_id uuid,
  p_camp_id uuid,
  p_full_name text,
  p_gender text,
  p_age integer,
  p_address text,
  p_phone text,
  p_email text,
  p_aadhaar_last4 text,
  p_user_id uuid,
  p_created_by uuid,
  p_camp_day_id uuid,
  p_aadhaar_duplicate_override boolean,
  p_likely_duplicate_override boolean,
  p_self_service boolean,
  p_aadhaar_hash text,
  p_aadhaar_verified_at timestamptz,
  p_aadhaar_kyc_ref text,
  p_provenance text
) RETURNS TABLE(
  id uuid,
  reg_no integer,
  full_name text,
  camp_day_id uuid,
  day_date date,
  queue_status public.queue_status
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  select *
  from public.register_patient_idempotent(
    p_request_id, p_camp_id, p_full_name, p_gender, p_age, p_address,
    p_phone, p_email, p_aadhaar_last4, p_user_id, p_created_by,
    p_camp_day_id, p_aadhaar_duplicate_override,
    p_likely_duplicate_override, p_self_service,
    p_aadhaar_hash, p_aadhaar_verified_at, p_aadhaar_kyc_ref,
    p_provenance, null::text, null::date
  );
$function$;

GRANT EXECUTE ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, boolean, text, timestamptz, text
) TO service_role, authenticated;

-- 18-parameter forwarder
CREATE OR REPLACE FUNCTION public.register_patient_idempotent(
  p_request_id uuid,
  p_camp_id uuid,
  p_full_name text,
  p_gender text,
  p_age integer,
  p_address text,
  p_phone text,
  p_email text,
  p_aadhaar_last4 text,
  p_user_id uuid,
  p_created_by uuid,
  p_camp_day_id uuid,
  p_aadhaar_duplicate_override boolean,
  p_likely_duplicate_override boolean,
  p_self_service boolean,
  p_aadhaar_hash text,
  p_aadhaar_verified_at timestamptz,
  p_aadhaar_kyc_ref text
) RETURNS TABLE(
  id uuid,
  reg_no integer,
  full_name text,
  camp_day_id uuid,
  day_date date,
  queue_status public.queue_status
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  select *
  from public.register_patient_idempotent(
    p_request_id, p_camp_id, p_full_name, p_gender, p_age, p_address,
    p_phone, p_email, p_aadhaar_last4, p_user_id, p_created_by,
    p_camp_day_id, p_aadhaar_duplicate_override,
    p_likely_duplicate_override, p_self_service,
    p_aadhaar_hash, p_aadhaar_verified_at, p_aadhaar_kyc_ref,
    'self_declared', null::text, null::date
  );
$function$;

GRANT EXECUTE ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, boolean, text, timestamptz, text
) TO service_role, authenticated;

-- 15-parameter forwarder
CREATE OR REPLACE FUNCTION public.register_patient_idempotent(
  p_request_id uuid,
  p_camp_id uuid,
  p_full_name text,
  p_gender text,
  p_age integer,
  p_address text,
  p_phone text,
  p_email text,
  p_aadhaar_last4 text,
  p_user_id uuid,
  p_created_by uuid,
  p_camp_day_id uuid,
  p_aadhaar_duplicate_override boolean,
  p_likely_duplicate_override boolean,
  p_self_service boolean
) RETURNS TABLE(
  id uuid,
  reg_no integer,
  full_name text,
  camp_day_id uuid,
  day_date date,
  queue_status public.queue_status
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  select *
  from public.register_patient_idempotent(
    p_request_id, p_camp_id, p_full_name, p_gender, p_age, p_address,
    p_phone, p_email, p_aadhaar_last4, p_user_id, p_created_by,
    p_camp_day_id, p_aadhaar_duplicate_override,
    p_likely_duplicate_override, p_self_service,
    null::text, null::timestamptz, null::text,
    'self_declared', null::text, null::date
  );
$function$;

GRANT EXECUTE ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, boolean
) TO service_role, authenticated;

-- 14-parameter forwarder (with parameter defaults matching 20260726190000_sms_deliveries_ledger.sql)
CREATE OR REPLACE FUNCTION public.register_patient_idempotent(
  p_request_id uuid,
  p_camp_id uuid,
  p_full_name text,
  p_gender text DEFAULT NULL::text,
  p_age integer DEFAULT NULL::integer,
  p_address text DEFAULT NULL::text,
  p_phone text DEFAULT NULL::text,
  p_email text DEFAULT NULL::text,
  p_aadhaar_last4 text DEFAULT NULL::text,
  p_user_id uuid DEFAULT NULL::uuid,
  p_created_by uuid DEFAULT NULL::uuid,
  p_camp_day_id uuid DEFAULT NULL::uuid,
  p_aadhaar_duplicate_override boolean DEFAULT false,
  p_likely_duplicate_override boolean DEFAULT false
) RETURNS TABLE(
  id uuid,
  reg_no integer,
  full_name text,
  camp_day_id uuid,
  day_date date,
  queue_status public.queue_status
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  select *
  from public.register_patient_idempotent(
    p_request_id, p_camp_id, p_full_name, p_gender, p_age, p_address,
    p_phone, p_email, p_aadhaar_last4, p_user_id, p_created_by,
    p_camp_day_id, p_aadhaar_duplicate_override,
    p_likely_duplicate_override, false,
    null::text, null::timestamptz, null::text,
    'self_declared', null::text, null::date
  );
$function$;

GRANT EXECUTE ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean
) TO service_role, authenticated;
