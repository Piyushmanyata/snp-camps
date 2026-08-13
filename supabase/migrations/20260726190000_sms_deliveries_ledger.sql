-- #65 — Durable SMS delivery ledger (registration + reminder).
-- One logical delivery per (patient, template kind). Service/staff claim + complete.
-- Registration enqueue is transactional with register_patient_idempotent when phone set.
-- Legacy patients.reminder_sms_sent_at kept dual-written during compatibility window.

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.sms_delivery_kind AS ENUM ('registration', 'reminder');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE public.sms_delivery_state AS ENUM (
    'pending', 'sending', 'sent', 'failed', 'ambiguous'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.sms_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  kind public.sms_delivery_kind NOT NULL,
  state public.sms_delivery_state NOT NULL DEFAULT 'pending',
  claim_token uuid NULL,
  claim_expires_at timestamptz NULL,
  attempt_count integer NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0),
  provider_request_id text NULL,
  phone_last4 char(4) NULL
    CHECK (phone_last4 IS NULL OR phone_last4 ~ '^[0-9]{4}$'),
  last_error text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz NULL,
  CONSTRAINT sms_deliveries_patient_kind_unique UNIQUE (patient_id, kind),
  CONSTRAINT sms_deliveries_last_error_len CHECK (
    last_error IS NULL OR char_length(last_error) <= 300
  ),
  CONSTRAINT sms_deliveries_provider_id_len CHECK (
    provider_request_id IS NULL OR char_length(provider_request_id) <= 200
  )
);

COMMENT ON TABLE public.sms_deliveries IS
  'Durable SMS delivery ledger (#65). No full phone, message body, status token, or secrets.';
COMMENT ON COLUMN public.sms_deliveries.phone_last4 IS
  'Last 4 digits only for admin triage — never full phone.';
COMMENT ON COLUMN public.sms_deliveries.state IS
  'pending→sending→sent|failed|ambiguous. Stale sending reclaimable; ambiguous not auto-retried.';

CREATE INDEX IF NOT EXISTS sms_deliveries_state_updated_idx
  ON public.sms_deliveries (state, updated_at DESC);

CREATE INDEX IF NOT EXISTS sms_deliveries_kind_state_idx
  ON public.sms_deliveries (kind, state)
  WHERE state IN ('pending', 'failed', 'sending');

ALTER TABLE public.sms_deliveries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.sms_deliveries FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.sms_deliveries TO postgres, service_role;

-- No direct table policies for authenticated — admin/staff use SECURITY DEFINER RPCs.

-- ---------------------------------------------------------------------------
-- claim_sms_delivery — atomic lease; concurrent runners: at most one winner
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_sms_delivery(
  p_patient_id uuid,
  p_kind public.sms_delivery_kind,
  p_phone_last4 text DEFAULT NULL,
  p_lease_seconds integer DEFAULT 120
)
RETURNS TABLE (
  delivery_id uuid,
  claim_token uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_role text;
  v_last4 char(4);
  v_lease integer := greatest(coalesce(p_lease_seconds, 120), 30);
BEGIN
  v_role := coalesce(
    nullif(auth.role(), ''),
    nullif(current_setting('request.jwt.claim.role', true), '')
  );
  IF v_role IS DISTINCT FROM 'service_role' AND NOT public.is_staff() THEN
    RAISE EXCEPTION 'staff or service role required';
  END IF;

  IF p_patient_id IS NULL OR p_kind IS NULL THEN
    RAISE EXCEPTION 'patient and kind required';
  END IF;

  v_last4 := NULL;
  IF p_phone_last4 IS NOT NULL AND length(trim(p_phone_last4)) > 0 THEN
    v_last4 := right(regexp_replace(p_phone_last4, '\D', '', 'g'), 4);
    IF v_last4 !~ '^[0-9]{4}$' THEN
      v_last4 := NULL;
    END IF;
  END IF;

  -- Ensure logical row exists (registration may have enqueued already).
  INSERT INTO public.sms_deliveries (patient_id, kind, state, phone_last4)
  VALUES (p_patient_id, p_kind, 'pending', v_last4)
  ON CONFLICT (patient_id, kind) DO NOTHING;

  IF v_last4 IS NOT NULL THEN
    UPDATE public.sms_deliveries d
    SET phone_last4 = v_last4
    WHERE d.patient_id = p_patient_id
      AND d.kind = p_kind
      AND d.phone_last4 IS NULL;
  END IF;

  RETURN QUERY
  WITH claimed AS (
    UPDATE public.sms_deliveries d
    SET
      state = 'sending',
      claim_token = gen_random_uuid(),
      claim_expires_at = now() + make_interval(secs => v_lease),
      attempt_count = d.attempt_count + 1,
      last_error = NULL,
      updated_at = now()
    WHERE d.patient_id = p_patient_id
      AND d.kind = p_kind
      AND (
        d.state IN ('pending', 'failed')
        OR (
          d.state = 'sending'
          AND d.claim_expires_at IS NOT NULL
          AND d.claim_expires_at < now()
        )
      )
    RETURNING d.id, d.claim_token
  ),
  legacy AS (
    -- Dual-write legacy reminder timestamp while compatibility window is open.
    UPDATE public.patients p
    SET reminder_sms_sent_at = coalesce(p.reminder_sms_sent_at, now())
    WHERE p_kind = 'reminder'
      AND EXISTS (SELECT 1 FROM claimed)
      AND p.id = p_patient_id
    RETURNING p.id
  )
  SELECT c.id, c.claim_token FROM claimed c;
END;
$$;

ALTER FUNCTION public.claim_sms_delivery(uuid, public.sms_delivery_kind, text, integer)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_sms_delivery(uuid, public.sms_delivery_kind, text, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_sms_delivery(uuid, public.sms_delivery_kind, text, integer)
  TO authenticated, service_role, postgres;

COMMENT ON FUNCTION public.claim_sms_delivery(uuid, public.sms_delivery_kind, text, integer) IS
  'Atomic SMS lease (#65). Not reclaimable when sent or ambiguous. Stale sending reclaimable.';

-- ---------------------------------------------------------------------------
-- complete_sms_delivery — terminal or failed outcome for a held claim
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_sms_delivery(
  p_delivery_id uuid,
  p_claim_token uuid,
  p_outcome text,
  p_provider_request_id text DEFAULT NULL,
  p_last_error text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_role text;
  v_kind public.sms_delivery_kind;
  v_patient uuid;
  v_state public.sms_delivery_state;
  v_outcome text := lower(trim(coalesce(p_outcome, '')));
  v_err text;
  v_req text;
  v_updated integer;
BEGIN
  v_role := coalesce(
    nullif(auth.role(), ''),
    nullif(current_setting('request.jwt.claim.role', true), '')
  );
  IF v_role IS DISTINCT FROM 'service_role' AND NOT public.is_staff() THEN
    RAISE EXCEPTION 'staff or service role required';
  END IF;

  IF v_outcome NOT IN ('sent', 'failed', 'ambiguous', 'release') THEN
    RAISE EXCEPTION 'invalid outcome';
  END IF;

  v_err := NULLIF(left(trim(coalesce(p_last_error, '')), 300), '');
  v_req := NULLIF(left(trim(coalesce(p_provider_request_id, '')), 200), '');

  IF v_outcome = 'release' THEN
    -- Unconfigured / no-op: return to pending for a later dispatch.
    UPDATE public.sms_deliveries d
    SET
      state = 'pending',
      claim_token = NULL,
      claim_expires_at = NULL,
      updated_at = now()
    WHERE d.id = p_delivery_id
      AND d.claim_token IS NOT DISTINCT FROM p_claim_token
      AND d.state = 'sending'
    RETURNING d.kind, d.patient_id INTO v_kind, v_patient;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated > 0 AND v_kind = 'reminder' THEN
      UPDATE public.patients SET reminder_sms_sent_at = NULL
      WHERE id = v_patient;
    END IF;
    RETURN v_updated > 0;
  END IF;

  IF v_outcome = 'sent' THEN
    v_state := 'sent';
  ELSIF v_outcome = 'failed' THEN
    v_state := 'failed';
  ELSE
    v_state := 'ambiguous';
  END IF;

  UPDATE public.sms_deliveries d
  SET
    state = v_state,
    claim_token = CASE WHEN v_state = 'failed' THEN NULL ELSE d.claim_token END,
    claim_expires_at = CASE WHEN v_state = 'failed' THEN NULL ELSE d.claim_expires_at END,
    provider_request_id = COALESCE(v_req, d.provider_request_id),
    last_error = CASE WHEN v_state = 'sent' THEN NULL ELSE v_err END,
    sent_at = CASE WHEN v_state = 'sent' THEN now() ELSE d.sent_at END,
    updated_at = now()
  WHERE d.id = p_delivery_id
    AND d.claim_token IS NOT DISTINCT FROM p_claim_token
    AND d.state = 'sending'
  RETURNING d.kind, d.patient_id INTO v_kind, v_patient;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    RETURN false;
  END IF;

  -- Dual-write legacy column: clear only on known failed (safe to auto-retry).
  IF v_kind = 'reminder' AND v_state = 'failed' THEN
    UPDATE public.patients SET reminder_sms_sent_at = NULL
    WHERE id = v_patient;
  ELSIF v_kind = 'reminder' AND v_state = 'sent' THEN
    UPDATE public.patients
    SET reminder_sms_sent_at = coalesce(reminder_sms_sent_at, now())
    WHERE id = v_patient;
  END IF;
  -- ambiguous: keep reminder_sms_sent_at so legacy path also avoids resend

  RETURN true;
END;
$$;

ALTER FUNCTION public.complete_sms_delivery(uuid, uuid, text, text, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.complete_sms_delivery(uuid, uuid, text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_sms_delivery(uuid, uuid, text, text, text)
  TO authenticated, service_role, postgres;

-- ---------------------------------------------------------------------------
-- Admin redacted projection of failed/ambiguous (durable across instances)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_recent_sms_delivery_issues(
  p_limit integer DEFAULT 50
)
RETURNS TABLE (
  at timestamptz,
  template text,
  detail text,
  phone_last4 text,
  state text,
  kind text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_lim integer := least(greatest(coalesce(p_limit, 50), 1), 100);
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only';
  END IF;

  RETURN QUERY
  SELECT
    d.updated_at AS at,
    d.kind::text AS template,
    coalesce(d.last_error, d.state::text) AS detail,
    d.phone_last4::text,
    d.state::text,
    d.kind::text
  FROM public.sms_deliveries d
  WHERE d.state IN ('failed', 'ambiguous')
  ORDER BY d.updated_at DESC
  LIMIT v_lim;
END;
$$;

ALTER FUNCTION public.list_recent_sms_delivery_issues(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_recent_sms_delivery_issues(integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_recent_sms_delivery_issues(integer)
  TO authenticated, service_role, postgres;

-- ---------------------------------------------------------------------------
-- Bounded retention (sent 30d; failed/ambiguous 90d; pending/sending kept)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prune_sms_deliveries()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_role text;
  v_n integer;
BEGIN
  v_role := coalesce(
    nullif(auth.role(), ''),
    nullif(current_setting('request.jwt.claim.role', true), '')
  );
  IF v_role IS DISTINCT FROM 'service_role' AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin or service role required';
  END IF;

  DELETE FROM public.sms_deliveries d
  WHERE (d.state = 'sent' AND d.updated_at < now() - interval '30 days')
     OR (d.state IN ('failed', 'ambiguous') AND d.updated_at < now() - interval '90 days');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

ALTER FUNCTION public.prune_sms_deliveries() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.prune_sms_deliveries() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prune_sms_deliveries()
  TO service_role, postgres;

-- ---------------------------------------------------------------------------
-- Backfill: prior reminder claims → sent (compatibility)
-- ---------------------------------------------------------------------------
INSERT INTO public.sms_deliveries (
  patient_id, kind, state, phone_last4, sent_at, updated_at, created_at
)
SELECT
  p.id,
  'reminder'::public.sms_delivery_kind,
  'sent'::public.sms_delivery_state,
  CASE
    WHEN p.phone IS NOT NULL AND length(regexp_replace(p.phone, '\D', '', 'g')) >= 4
      THEN right(regexp_replace(p.phone, '\D', '', 'g'), 4)::char(4)
    ELSE NULL
  END,
  p.reminder_sms_sent_at,
  p.reminder_sms_sent_at,
  p.reminder_sms_sent_at
FROM public.patients p
WHERE p.reminder_sms_sent_at IS NOT NULL
ON CONFLICT (patient_id, kind) DO NOTHING;

-- ---------------------------------------------------------------------------
-- register_patient_idempotent — same as #67 + transactional registration enqueue
-- ---------------------------------------------------------------------------
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
begin
  if p_request_id is null then
    raise exception 'registration request id required';
  end if;

  -- p_user_id is intentionally ignored: patient Auth ownership retired (#59).

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

  v_phone10 := nullif(
    right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10),
    ''
  );
  if v_phone10 is not null and length(v_phone10) < 10 then
    v_phone10 := null;
  end if;

  v_today := (timezone('Asia/Kolkata', now()))::date;
  v_is_walkin := v_day.day_date = v_today;
  if v_is_walkin then
    v_status := 'waiting';
    v_queued_at := now();
    v_checked_in_by := coalesce((select auth.uid()), v_created_by);
  else
    v_status := 'registered';
    v_queued_at := null;
    v_checked_in_by := null;
  end if;

  -- #67 soft-duplicate serialization
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

  begin
    insert into public.patients (
      registration_request_id,
      camp_id,
      camp_day_id,
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
      likely_duplicate_override_at
    )
    values (
      p_request_id,
      p_camp_id,
      p_camp_day_id,
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
      v_likely_at
    )
    returning public.patients.* into v_row;
  exception
    when unique_violation then
      select p.reg_no
      into v_conflict_reg
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

  -- #65: durable registration SMS work even if browser never calls notify.
  if v_phone10 is not null then
    insert into public.sms_deliveries (patient_id, kind, state, phone_last4)
    values (
      v_row.id,
      'registration',
      'pending',
      right(v_phone10, 4)::char(4)
    )
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
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid, boolean, boolean
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid, boolean, boolean
) FROM PUBLIC;
GRANT ALL ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid, boolean, boolean
) TO service_role;
GRANT ALL ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid, boolean, boolean
) TO authenticated;

COMMENT ON FUNCTION public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid, boolean, boolean
) IS
  'Staff registration. Soft-dup locks (#67). Enqueues registration SMS delivery when phone set (#65).';
