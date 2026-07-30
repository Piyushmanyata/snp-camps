-- #79 — self-service queue semantics and Aadhaar verification provenance.
--
-- The existing 14-argument RPC remains intact for desk callers (its omitted
-- self-service mode is therefore the effective false default). Explicit
-- 15- and 18-argument forms add p_self_service and the server-computed
-- verification provenance needed by the eKYC route. Keeping the old exact
-- signature preserves existing callers and the current DB-test seam.

ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS aadhaar_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS aadhaar_kyc_ref text,
  ADD COLUMN IF NOT EXISTS aadhaar_hash text;

COMMENT ON COLUMN public.patients.aadhaar_verified_at IS
  'When Aadhaar eKYC verification succeeded; null means not verified.';

COMMENT ON COLUMN public.patients.aadhaar_kyc_ref IS
  'Provider reference for an Aadhaar eKYC verification; never the Aadhaar number.';

COMMENT ON COLUMN public.patients.aadhaar_hash IS
  'Server-computed keyed HMAC-SHA256 of the full Aadhaar digits; the full number is never stored.';

-- Self-service rows have no staff creator. Desk registrations therefore do
-- not participate in this uniqueness constraint, even when a future desk
-- verification records its own provenance.
CREATE UNIQUE INDEX IF NOT EXISTS patients_camp_self_service_aadhaar_hash_uidx
  ON public.patients (camp_id, aadhaar_hash)
  WHERE aadhaar_hash IS NOT NULL
    AND aadhaar_verified_at IS NOT NULL
    AND created_by IS NULL;

GRANT SELECT (aadhaar_verified_at) ON TABLE public.patients TO authenticated;
GRANT SELECT (aadhaar_kyc_ref) ON TABLE public.patients TO authenticated;

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
begin
  if p_request_id is null then
    raise exception 'registration request id required';
  end if;

  -- p_user_id is intentionally ignored: patient Auth ownership is retired.
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

  -- Serialize retries before looking up their committed result.
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

  -- Keep the capacity critical-section order shared with desk registration.
  select * into v_day
  from public.camp_days d
  where d.id = p_camp_day_id
  for update;

  if v_day.id is null or v_day.camp_id is distinct from p_camp_id then
    raise exception 'Invalid camp day';
  end if;

  -- A same-camp self-service retry is a successful lookup, not a duplicate
  -- error. The advisory lock makes different request ids converge before the
  -- partial unique index is reached.
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

  -- Serialize soft-duplicate keys in the same stable order as the desk RPC.
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
    raise exception 'LIKELY_DUPLICATE:reg=%', v_soft_reg;
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
      raise exception 'AADHAAR_DUPLICATE:reg=%', v_conflict_reg;
    end if;
  end if;

  begin
    insert into public.patients (
      registration_request_id, camp_id, camp_day_id, full_name, gender, age,
      address, phone, email, aadhaar_last4, created_by, queue_status,
      queued_at, checked_in_by, aadhaar_hash, aadhaar_verified_at, aadhaar_kyc_ref
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
      v_hash, v_verified_at, v_kyc_ref
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
      raise;
  end;

  -- Keep the durable registration-SMS enqueue parity of the current RPC.
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

COMMENT ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid,
  boolean, boolean, boolean, text, timestamptz, text
) IS
  'Issue #79: p_self_service never checks in a patient; provenance is server-computed and full Aadhaar is never stored.';

-- Convenience form for self-service callers that do not yet need to pass
-- provenance through the RPC. It is explicit arity rather than a defaulted
-- overload so legacy 14-argument calls cannot become ambiguous.
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
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  select *
  from public.register_patient_idempotent(
    p_request_id, p_camp_id, p_full_name, p_gender, p_age, p_address,
    p_phone, p_email, p_aadhaar_last4, p_user_id, p_created_by,
    p_camp_day_id, p_aadhaar_duplicate_override,
    p_likely_duplicate_override, p_self_service,
    null::text, null::timestamptz, null::text
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
