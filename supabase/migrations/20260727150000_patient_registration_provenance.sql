-- Migration: 20260727150000_patient_registration_provenance.sql
-- Issue #92: Add provenance to patients table and update registration RPCs.

ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS provenance text NOT NULL DEFAULT 'self_declared';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'patients_provenance_check'
  ) THEN
    ALTER TABLE public.patients
      ADD CONSTRAINT patients_provenance_check
      CHECK (provenance IN ('self_declared', 'ekyc_verified', 'card_verified'));
  END IF;
END $$;

COMMENT ON COLUMN public.patients.provenance IS
  'Source of patient registration details: self_declared (manual or unverified QR scan), ekyc_verified (OTP), or card_verified (cryptographic signature).';

GRANT SELECT (provenance) ON TABLE public.patients TO authenticated;

-- Main 19-parameter function (no defaults to avoid ambiguity with overloads)
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
  v_hash text;
  v_kyc_ref text;
  v_verified_at timestamptz;
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
  v_status public.queue_status;
  v_queued_at timestamptz;
  v_checked_in_by uuid;
  v_soft_lock_keys text[] := array[]::text[];
  v_soft_lock text;
  v_provenance text;
begin
  if p_request_id is null then
    raise exception 'registration request id required';
  end if;

  v_request_role := coalesce(
    nullif(auth.role(), ''),
    nullif(current_setting('request.jwt.claim.role', true), '')
  );

  if v_request_role = 'service_role' then
    v_created_by := case when coalesce(p_self_service, false) then null else p_created_by end;
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
    if coalesce(p_self_service, false) then
      raise exception 'self-service registration requires service_role';
    end if;
    v_created_by := (select auth.uid());
  else
    raise exception 'authenticated registration required';
  end if;

  v_hash := nullif(btrim(p_aadhaar_hash), '');
  v_kyc_ref := nullif(btrim(p_aadhaar_kyc_ref), '');
  v_verified_at := p_aadhaar_verified_at;
  v_provenance := coalesce(p_provenance, 'self_declared');

  if v_provenance not in ('self_declared', 'ekyc_verified', 'card_verified') then
    raise exception 'Invalid provenance value';
  end if;

  if coalesce(p_self_service, false) then
    if v_hash is null or v_verified_at is null or v_kyc_ref is null then
      raise exception 'verified Aadhaar provenance required for self-service registration';
    end if;
  elsif v_hash is not null or v_verified_at is not null or v_kyc_ref is not null then
    if v_hash is null or v_verified_at is null or v_kyc_ref is null then
      raise exception 'Aadhaar verification provenance must be complete';
    end if;
    if v_created_by is null then
      raise exception 'created_by required for desk Aadhaar verification';
    end if;
  end if;

  if v_hash is not null and length(v_hash) > 128 then
    raise exception 'Aadhaar hash is too long';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('register-request:' || p_request_id::text)
  );

  select p.id, p.reg_no, p.full_name, p.camp_day_id, d.day_date, p.queue_status
  into id, reg_no, full_name, camp_day_id, day_date, queue_status
  from public.patients p
  left join public.camp_days d on d.id = p.camp_day_id
  where p.registration_request_id = p_request_id;

  if found then
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
    select 1 from public.camps c where c.id = p_camp_id and c.is_active
  ) then
    raise exception 'No active camp';
  end if;

  if p_camp_day_id is null then
    raise exception 'Please select a camp day';
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

  select * into v_day
  from public.camp_days d
  where d.id = p_camp_day_id
  for update;

  if v_day.id is null or v_day.camp_id is distinct from p_camp_id then
    raise exception 'Invalid camp day';
  end if;

  if coalesce(p_self_service, false) then
    perform pg_advisory_xact_lock(
      hashtext('snp-reg-aadhaar'),
      hashtext(p_camp_id::text || ':' || v_hash)
    );
    select p.id, p.reg_no, p.full_name, p.camp_day_id, d.day_date, p.queue_status
    into id, reg_no, full_name, camp_day_id, day_date, queue_status
    from public.patients p
    left join public.camp_days d on d.id = p.camp_day_id
    where p.camp_id = p_camp_id
      and p.aadhaar_hash = v_hash
      and p.aadhaar_verified_at is not null
      and p.created_by is null
    order by p.reg_no
    limit 1;
    if found then
      return next;
      return;
    end if;
  end if;

  select count(*)::integer into v_taken
  from public.patients p where p.camp_day_id = p_camp_day_id;
  if v_taken >= v_day.seat_limit then
    raise exception 'This day is full (% seats). Choose another day.', v_day.seat_limit;
  end if;

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
    into v_soft_lock_keys from unnest(v_soft_lock_keys) as k;
    foreach v_soft_lock in array v_soft_lock_keys loop
      perform pg_advisory_xact_lock(
        hashtext('snp-reg-likely-dup'), hashtext(v_soft_lock)
      );
    end loop;
  end if;

  select p.reg_no into v_soft_reg
  from public.patients p
  where p.camp_id = p_camp_id
    and (
      (p_age is not null and p.age is not null
       and p.full_name_normalized = v_name_norm and p.age = p_age)
      or (v_phone10 is not null and p.phone_normalized is not null
       and p.phone_normalized = v_phone10)
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
    select p.reg_no into v_conflict_reg
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

  begin
    insert into public.patients (
      registration_request_id, camp_id, camp_day_id, full_name, gender, age,
      address, phone, email, aadhaar_last4, created_by, queue_status,
      queued_at, checked_in_by, aadhaar_hash, aadhaar_verified_at, aadhaar_kyc_ref,
      aadhaar_duplicate_override_by, aadhaar_duplicate_override_at,
      likely_duplicate_override_by, likely_duplicate_override_at, provenance
    ) values (
      p_request_id, p_camp_id, p_camp_day_id, v_name,
      case when p_gender in ('M', 'F', 'O') then p_gender else null end,
      p_age, nullif(trim(coalesce(p_address, '')), ''), v_phone10,
      nullif(trim(coalesce(p_email, '')), ''), v_aadhaar, v_created_by,
      case when coalesce(p_self_service, false) then 'registered'::public.queue_status
           when v_day.day_date = (timezone('Asia/Kolkata', now()))::date
             then 'waiting'::public.queue_status
           else 'registered'::public.queue_status end,
      case when coalesce(p_self_service, false) then null else
        case when v_day.day_date = (timezone('Asia/Kolkata', now()))::date
             then now() else null end end,
      case when coalesce(p_self_service, false) then null else
        case when v_day.day_date = (timezone('Asia/Kolkata', now()))::date
             then coalesce((select auth.uid()), v_created_by) else null end end,
      v_hash, v_verified_at, v_kyc_ref,
      v_override_by, v_override_at, v_likely_by, v_likely_at, v_provenance
    ) returning public.patients.* into v_row;
  exception
    when unique_violation then
      if coalesce(p_self_service, false) then
        select p.id, p.reg_no, p.full_name, p.camp_day_id, d.day_date, p.queue_status
        into id, reg_no, full_name, camp_day_id, day_date, queue_status
        from public.patients p
        left join public.camp_days d on d.id = p.camp_day_id
        where p.camp_id = p_camp_id
          and p.aadhaar_hash = v_hash
          and p.aadhaar_verified_at is not null
          and p.created_by is null
        order by p.reg_no
        limit 1;
        if found then
          return next;
          return;
        end if;
      end if;
      select p.reg_no into v_conflict_reg
      from public.patients p
      where p.camp_id = p_camp_id
        and p.aadhaar_last4 = v_aadhaar
        and p.full_name_normalized = v_name_norm
        and p.aadhaar_duplicate_override_at is null
      limit 1;
      if v_conflict_reg is not null then
        raise exception 'AADHAAR_DUPLICATE:reg=%', v_conflict_reg;
      end if;
      raise;
  end;

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

ALTER FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, boolean, text, timestamptz, text, text
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, boolean, text, timestamptz, text, text
) FROM PUBLIC;
GRANT ALL ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, boolean, text, timestamptz, text, text
) TO service_role;
GRANT ALL ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, boolean, text, timestamptz, text, text
) TO authenticated;

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
    'self_declared'
  );
$function$;

ALTER FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, boolean, text, timestamptz, text
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, boolean, text, timestamptz, text
) FROM PUBLIC;
GRANT ALL ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, boolean, text, timestamptz, text
) TO service_role;
GRANT ALL ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, boolean, text, timestamptz, text
) TO authenticated;

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
    'self_declared'
  );
$function$;

ALTER FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, boolean
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, boolean
) FROM PUBLIC;
GRANT ALL ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, boolean
) TO service_role;
GRANT ALL ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, boolean
) TO authenticated;

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
    'self_declared'
  );
$function$;

ALTER FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean
) FROM PUBLIC;
GRANT ALL ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean
) TO service_role;
GRANT ALL ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean
) TO authenticated;

-- Alias register_patient_v2 RPC
CREATE OR REPLACE FUNCTION public.register_patient_v2(
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
  p_likely_duplicate_override boolean DEFAULT false,
  p_provenance text DEFAULT 'self_declared'
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
    p_provenance
  );
$function$;

ALTER FUNCTION public.register_patient_v2(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, text
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.register_patient_v2(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, text
) FROM PUBLIC;
GRANT ALL ON FUNCTION public.register_patient_v2(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, text
) TO service_role;
GRANT ALL ON FUNCTION public.register_patient_v2(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, text
) TO authenticated;
