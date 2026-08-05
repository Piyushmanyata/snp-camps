-- Full-codebase audit remediation — Batch 2.
-- Append-only hardening for readiness, Auth, privacy, least-privilege RPCs,
-- SMS leases, and sponsor-asset lifecycle metadata.

-- ---------------------------------------------------------------------------
-- F13 — sponsor asset lifecycle metadata
-- ---------------------------------------------------------------------------
ALTER TABLE public.sponsor_assets
  ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'ready',
  ADD COLUMN IF NOT EXISTS state_changed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS cleanup_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error_code text;

ALTER TABLE public.sponsor_assets
  DROP CONSTRAINT IF EXISTS sponsor_assets_state_check;
ALTER TABLE public.sponsor_assets
  ADD CONSTRAINT sponsor_assets_state_check
  CHECK (state IN ('pending', 'ready', 'deleting'));

ALTER TABLE public.sponsor_assets
  DROP CONSTRAINT IF EXISTS sponsor_assets_cleanup_attempts_check;
ALTER TABLE public.sponsor_assets
  ADD CONSTRAINT sponsor_assets_cleanup_attempts_check
  CHECK (cleanup_attempts >= 0);

ALTER TABLE public.sponsor_assets
  DROP CONSTRAINT IF EXISTS sponsor_assets_last_error_code_check;
ALTER TABLE public.sponsor_assets
  ADD CONSTRAINT sponsor_assets_last_error_code_check
  CHECK (
    last_error_code IS NULL
    OR last_error_code ~ '^[A-Z0-9_]{1,64}$'
  );

-- ---------------------------------------------------------------------------
-- F32/F33 — anonymous camp-day privacy and attribution indexes
-- ---------------------------------------------------------------------------
REVOKE SELECT ON TABLE public.camp_days FROM anon;
DROP POLICY IF EXISTS "anon read camp days" ON public.camp_days;

-- Ordinary authenticated staff use the narrow workflow RPCs below; only admins
-- retain direct patient-table SELECT for admin patient screens.
DROP POLICY IF EXISTS "authenticated read permitted patients" ON public.patients;
DROP POLICY IF EXISTS "admin read patients" ON public.patients;
CREATE POLICY "admin read patients"
  ON public.patients
  FOR SELECT
  TO authenticated
  USING ((SELECT public.is_admin()));

CREATE INDEX IF NOT EXISTS idx_deferred_slips_issued_by
  ON public.deferred_slips (issued_by);
CREATE INDEX IF NOT EXISTS idx_fulfilment_events_created_by
  ON public.fulfilment_events (created_by);
CREATE INDEX IF NOT EXISTS idx_fulfilment_items_resolved_by
  ON public.fulfilment_items (resolved_by);
CREATE INDEX IF NOT EXISTS idx_prescription_corrections_created_by
  ON public.prescription_corrections (created_by);
CREATE INDEX IF NOT EXISTS idx_prescription_template_versions_created_by
  ON public.prescription_template_versions (created_by);
CREATE INDEX IF NOT EXISTS idx_prescription_transcriptions_created_by
  ON public.prescription_transcriptions (created_by);
CREATE INDEX IF NOT EXISTS idx_prescription_transcriptions_updated_by
  ON public.prescription_transcriptions (updated_by);
CREATE INDEX IF NOT EXISTS idx_sponsor_assets_created_by
  ON public.sponsor_assets (created_by);

-- ---------------------------------------------------------------------------
-- F07 — bound SMS claim leases while preserving the public signature
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_sms_delivery(
  p_patient_id uuid,
  p_kind public.sms_delivery_kind,
  p_phone_last4 text DEFAULT NULL,
  p_lease_seconds integer DEFAULT 120
) RETURNS TABLE(delivery_id uuid, claim_token uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
    RAISE EXCEPTION 'lease must be between 30 and 300 seconds'
      USING ERRCODE = '22023';
  END IF;

  IF p_kind = 'registration'
     AND EXISTS (
       SELECT 1
       FROM public.patients AS p
       LEFT JOIN public.camp_days AS d ON d.id = p.camp_day_id
       WHERE p.id = p_patient_id
         AND (
           p.created_by IS NULL
           OR (
             d.day_date IS NOT NULL
             AND d.day_date <= (timezone('Asia/Kolkata', now()))::date
           )
         )
     )
  THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT *
  FROM public.claim_sms_delivery_impl(
    p_patient_id,
    p_kind,
    p_phone_last4,
    p_lease_seconds
  );
END;
$function$;

ALTER FUNCTION public.claim_sms_delivery(
  uuid, public.sms_delivery_kind, text, integer
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_sms_delivery(
  uuid, public.sms_delivery_kind, text, integer
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_sms_delivery(
  uuid, public.sms_delivery_kind, text, integer
) TO authenticated, service_role, postgres;

-- ---------------------------------------------------------------------------
-- F19 — canonical original-registrar KPI contract
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.staff_person_kpis(
  uuid, text, uuid, timestamptz, text
);

CREATE OR REPLACE FUNCTION public.staff_person_kpis(
  p_user_id uuid,
  p_role text,
  p_camp_id uuid DEFAULT NULL,
  p_scope text DEFAULT 'person'
) RETURNS TABLE(
  total bigint,
  today bigint,
  waiting bigint,
  seen bigint,
  label text,
  staff_id uuid,
  full_name text,
  staff_role public.user_role,
  distinct_patients integer,
  team_lead_id uuid,
  team_headcount integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_caller uuid := (SELECT auth.uid());
  v_caller_role public.user_role;
  v_target_role public.user_role;
  v_camp_id uuid;
  v_total bigint := 0;
  v_seen bigint := 0;
  v_headcount integer := 0;
BEGIN
  SELECT role INTO v_caller_role
  FROM public.profiles
  WHERE id = v_caller AND disabled_at IS NULL;

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'team_lead', 'volunteer') THEN
    RAISE EXCEPTION 'active camp crew required';
  END IF;

  IF p_scope = 'leaderboard' THEN
    IF p_user_id IS NOT NULL OR p_role IS NOT NULL THEN
      RAISE EXCEPTION 'leaderboard target forbidden';
    END IF;
    IF v_caller_role NOT IN ('admin', 'team_lead') THEN
      RAISE EXCEPTION 'leaderboard access forbidden';
    END IF;

    SELECT id INTO v_camp_id FROM public.camps
    WHERE id = p_camp_id AND is_active;

    RETURN QUERY
    WITH roster AS (
      SELECT p.id, p.full_name, p.role, p.team_lead_id,
        CASE WHEN v_camp_id IS NULL THEN 0 ELSE (
          SELECT count(*)::integer
          FROM public.patients x
          WHERE x.camp_id = v_camp_id
            AND x.created_by = p.id
            AND x.provenance <> 'manual_exception'
        ) END AS registered_count,
        CASE WHEN v_camp_id IS NULL THEN 0 ELSE (
          SELECT count(*)::integer
          FROM public.patients x
          WHERE x.camp_id = v_camp_id
            AND x.created_by = p.id
            AND x.provenance <> 'manual_exception'
            AND x.queue_status = 'seen'
        ) END AS seen_count,
        CASE WHEN p.role = 'team_lead' THEN (
          SELECT count(*)::integer
          FROM public.profiles member
          WHERE member.team_lead_id = p.id
            AND member.role = 'volunteer'
            AND member.disabled_at IS NULL
        ) ELSE 0 END AS headcount
      FROM public.profiles p
      WHERE p.disabled_at IS NULL
        AND p.role IN ('team_lead', 'volunteer')
    )
    SELECT
      registered_count::bigint,
      0::bigint,
      0::bigint,
      seen_count::bigint,
      'Registered'::text,
      id,
      full_name,
      role,
      registered_count,
      team_lead_id,
      headcount
    FROM roster
    ORDER BY registered_count DESC, full_name NULLS LAST, id;
    RETURN;
  END IF;

  IF p_scope <> 'person' OR p_user_id IS NULL OR p_role IS NULL
     OR p_role NOT IN ('volunteer', 'team_lead') THEN
    RAISE EXCEPTION 'invalid KPI target';
  END IF;

  SELECT role INTO v_target_role
  FROM public.profiles
  WHERE id = p_user_id AND disabled_at IS NULL;
  IF v_target_role IS NULL OR v_target_role::text <> p_role THEN
    RAISE EXCEPTION 'invalid KPI target';
  END IF;

  IF v_caller_role <> 'admin' AND v_caller <> p_user_id
     AND NOT (
       v_caller_role = 'team_lead'
       AND v_target_role = 'volunteer'
       AND EXISTS (
         SELECT 1 FROM public.profiles member
         WHERE member.id = p_user_id
           AND member.team_lead_id = v_caller
           AND member.disabled_at IS NULL
       )
     ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT id INTO v_camp_id FROM public.camps
  WHERE id = p_camp_id AND is_active;

  SELECT count(*)::bigint,
    count(*) FILTER (WHERE queue_status = 'seen')::bigint
  INTO v_total, v_seen
  FROM public.patients
  WHERE camp_id = v_camp_id
    AND created_by = p_user_id
    AND provenance <> 'manual_exception';

  SELECT count(*)::integer INTO v_headcount
  FROM public.profiles member
  WHERE member.team_lead_id = p_user_id
    AND member.role = 'volunteer'
    AND member.disabled_at IS NULL;

  RETURN QUERY
  SELECT v_total, 0::bigint, 0::bigint, v_seen,
    'Registered'::text, p_user_id, profile.full_name, profile.role,
    v_total::integer, profile.team_lead_id, v_headcount
  FROM public.profiles profile
  WHERE profile.id = p_user_id;
END;
$function$;

ALTER FUNCTION public.staff_person_kpis(uuid, text, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.staff_person_kpis(uuid, text, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_person_kpis(uuid, text, uuid, text)
  TO authenticated, service_role, postgres;

-- ---------------------------------------------------------------------------
-- F31 — narrow workflow projections for non-admin staff
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.desk_waiting_queue(
  p_camp_id uuid,
  p_limit integer DEFAULT 100
) RETURNS TABLE(
  id uuid,
  reg_no integer,
  full_name text,
  phone text,
  queued_at timestamptz,
  waiting_total bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 101);
BEGIN
  IF NOT public.is_staff() THEN
    RAISE EXCEPTION 'active registration staff required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.camps WHERE id = p_camp_id AND is_active) THEN
    RAISE EXCEPTION 'active camp required';
  END IF;

  RETURN QUERY
  WITH queue AS (
    SELECT p.id, p.reg_no, p.full_name, p.phone, p.queued_at,
      count(*) OVER ()::bigint AS exact_waiting_total
    FROM public.patients p
    WHERE p.camp_id = p_camp_id AND p.queue_status = 'waiting'
    ORDER BY p.queued_at NULLS LAST, p.reg_no, p.id
    LIMIT v_limit
  )
  SELECT q.id, q.reg_no, q.full_name, q.phone, q.queued_at,
    q.exact_waiting_total
  FROM queue q;
END;
$function$;

CREATE OR REPLACE FUNCTION public.print_patient(p_patient_id uuid)
RETURNS TABLE(
  id uuid,
  reg_no integer,
  full_name text,
  age integer,
  gender text,
  address text,
  phone text,
  queue_status public.queue_status,
  camp_id uuid,
  camp_name text,
  venue text,
  prescription_template jsonb,
  day_date date
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF NOT public.is_staff() THEN
    RAISE EXCEPTION 'active registration staff required';
  END IF;

  RETURN QUERY
  SELECT p.id, p.reg_no, p.full_name, p.age, p.gender, p.address, p.phone,
    p.queue_status, c.id, c.name, c.venue, c.prescription_template, d.day_date
  FROM public.patients p
  JOIN public.camps c ON c.id = p.camp_id AND c.is_active
  JOIN public.camp_days d ON d.id = p.camp_day_id
  WHERE p.id = p_patient_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.staff_registered_patients(
  p_staff_id uuid,
  p_limit integer DEFAULT 50
) RETURNS TABLE(
  id uuid,
  reg_no integer,
  full_name text,
  created_at timestamptz,
  queue_status public.queue_status
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 50);
  v_caller uuid := (SELECT auth.uid());
BEGIN
  IF NOT public.is_staff() THEN
    RAISE EXCEPTION 'active registration staff required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles target
    WHERE target.id = p_staff_id
      AND target.role IN ('volunteer', 'team_lead')
      AND target.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'staff member not found';
  END IF;

  IF NOT public.is_admin() AND v_caller <> p_staff_id
     AND NOT EXISTS (
       SELECT 1 FROM public.profiles target
       WHERE target.id = p_staff_id
         AND target.team_lead_id = v_caller
         AND target.role = 'volunteer'
         AND target.disabled_at IS NULL
     ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  RETURN QUERY
  SELECT p.id, p.reg_no, p.full_name, p.created_at, p.queue_status
  FROM public.patients p
  WHERE p.created_by = p_staff_id
  ORDER BY p.created_at DESC, p.id DESC
  LIMIT v_limit;
END;
$function$;

ALTER FUNCTION public.desk_waiting_queue(uuid, integer) OWNER TO postgres;
ALTER FUNCTION public.print_patient(uuid) OWNER TO postgres;
ALTER FUNCTION public.staff_registered_patients(uuid, integer) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.desk_waiting_queue(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.print_patient(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.staff_registered_patients(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.desk_waiting_queue(uuid, integer)
  TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION public.print_patient(uuid)
  TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION public.staff_registered_patients(uuid, integer)
  TO authenticated, service_role, postgres;

-- ---------------------------------------------------------------------------
-- F13 — admin-only sponsor asset reconciliation seams
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.begin_sponsor_asset_deletion(p_asset_id uuid)
RETURNS TABLE(object_key text, state text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_asset public.sponsor_assets%rowtype;
  v_reference text := '/api/admin/sponsor-assets/' || p_asset_id::text;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only';
  END IF;

  SELECT * INTO v_asset
  FROM public.sponsor_assets
  WHERE id = p_asset_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'asset not found';
  END IF;

  IF v_asset.state = 'deleting' THEN
    RETURN QUERY SELECT v_asset.object_key, v_asset.state;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.prescription_template_versions t
    WHERE t.status IN ('draft', 'published')
      AND t.template->'sponsorLogos' ? v_reference
  ) THEN
    RAISE EXCEPTION 'asset is referenced by a template';
  END IF;

  IF v_asset.state NOT IN ('pending', 'ready') THEN
    RAISE EXCEPTION 'asset cannot be deleted';
  END IF;

  UPDATE public.sponsor_assets
  SET state = 'deleting', state_changed_at = now(), last_error_code = NULL
  WHERE id = p_asset_id
  RETURNING sponsor_assets.object_key, sponsor_assets.state
  INTO object_key, state;
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.finish_sponsor_asset_deletion(p_asset_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only';
  END IF;

  DELETE FROM public.sponsor_assets
  WHERE id = p_asset_id AND state = 'deleting';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'asset is not pending deletion';
  END IF;
  RETURN true;
END;
$function$;

ALTER FUNCTION public.begin_sponsor_asset_deletion(uuid) OWNER TO postgres;
ALTER FUNCTION public.finish_sponsor_asset_deletion(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.begin_sponsor_asset_deletion(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.finish_sponsor_asset_deletion(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.begin_sponsor_asset_deletion(uuid)
  TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION public.finish_sponsor_asset_deletion(uuid)
  TO authenticated, service_role, postgres;

-- Keep referenced sponsor rows locked for the complete template write so an
-- asset cannot transition to deleting between validation and commit.
CREATE OR REPLACE FUNCTION public.admin_save_prescription_template(
  p_camp_id uuid, p_template jsonb, p_publish boolean DEFAULT false
) RETURNS public.prescription_template_versions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_version integer;
  v_row public.prescription_template_versions;
  v_section_count integer;
  v_section_height numeric;
  v_logo_count integer;
  v_template jsonb;
  v_logo text;
  v_asset_id uuid;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only';
  END IF;
  IF jsonb_typeof(p_template) <> 'object'
     OR octet_length(p_template::text) > 65536
     OR jsonb_typeof(p_template->'sections') <> 'array'
     OR jsonb_typeof(p_template->'sponsorLogos') <> 'array'
  THEN
    RAISE EXCEPTION 'valid template schema required';
  END IF;

  SELECT count(*), coalesce(sum((s->>'heightMm')::numeric)
    FILTER (WHERE coalesce((s->>'visible')::boolean, true)), 0)
  INTO v_section_count, v_section_height
  FROM jsonb_array_elements(p_template->'sections') s
  WHERE jsonb_typeof(s) = 'object'
    AND s->>'key' IN ('remarks', 'medicines')
    AND char_length(btrim(s->>'label')) BETWEEN 1 AND 80
    AND jsonb_typeof(s->'heightMm') = 'number'
    AND (s->>'heightMm')::numeric IN (10, 16, 20, 26, 32)
    AND (s->'visible' IS NULL OR jsonb_typeof(s->'visible') = 'boolean');
  IF v_section_count <> jsonb_array_length(p_template->'sections')
     OR v_section_count NOT BETWEEN 1 AND 4
     OR v_section_height > 42
     OR (SELECT count(DISTINCT s->>'key')
         FROM jsonb_array_elements(p_template->'sections') s) <> v_section_count
  THEN
    RAISE EXCEPTION 'invalid or oversized template sections';
  END IF;

  SELECT count(*)
  INTO v_logo_count
  FROM jsonb_array_elements_text(p_template->'sponsorLogos') logo
  WHERE logo = '/brand/rupa-logo.png'
     OR logo ~ '^/api/admin/sponsor-assets/[0-9a-fA-F-]{36}$';
  IF v_logo_count <> jsonb_array_length(p_template->'sponsorLogos')
     OR v_logo_count > 8
  THEN
    RAISE EXCEPTION 'invalid sponsor assets';
  END IF;

  FOR v_logo IN
    SELECT jsonb_array_elements_text(p_template->'sponsorLogos')
  LOOP
    IF v_logo <> '/brand/rupa-logo.png' THEN
      v_asset_id := substring(
        v_logo FROM '^/api/admin/sponsor-assets/([0-9a-fA-F-]{36})$'
      )::uuid;
      PERFORM 1
      FROM public.sponsor_assets
      WHERE id = v_asset_id
        AND camp_id = p_camp_id
        AND state = 'ready'
      FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'sponsor asset is not ready for this camp';
      END IF;
    END IF;
  END LOOP;

  v_template := jsonb_set(p_template, '{fitsOnePage}', 'true'::jsonb, true);
  DELETE FROM public.prescription_template_versions
  WHERE camp_id = p_camp_id AND status = 'draft';
  SELECT coalesce(max(version), 0) + 1
  INTO v_version
  FROM public.prescription_template_versions
  WHERE camp_id = p_camp_id;
  IF p_publish THEN
    UPDATE public.prescription_template_versions
    SET status = 'superseded'
    WHERE camp_id = p_camp_id AND status = 'published';
  END IF;
  INSERT INTO public.prescription_template_versions(
    camp_id, version, status, template, created_by, published_at
  )
  VALUES (
    p_camp_id, v_version,
    CASE WHEN p_publish THEN 'published' ELSE 'draft' END,
    v_template, v_actor, CASE WHEN p_publish THEN now() ELSE NULL END
  )
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$function$;

ALTER FUNCTION public.admin_save_prescription_template(uuid, jsonb, boolean)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_save_prescription_template(uuid, jsonb, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_save_prescription_template(uuid, jsonb, boolean)
  TO authenticated, service_role, postgres;

-- ---------------------------------------------------------------------------
-- F06 — exact readiness catalog contract
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.readiness_catalog_probe()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_tables jsonb;
  v_columns jsonb;
  v_functions jsonb;
  v_invariants jsonb;
  v_grants jsonb;
  v_states jsonb;
  v_kinds jsonb;
  v_clinical_signatures text[] := ARRAY[
    'public.is_clinical_operator()',
    'public.clinical_lookup(uuid,integer)',
    'public.clinical_save_transcription(uuid,jsonb)',
    'public.clinical_add_correction(uuid,jsonb,text)',
    'public.clinical_resolve_item(uuid,text,text)',
    'public.clinical_followup_fulfil(uuid)',
    'public.clinical_followup_lookup(uuid,integer)',
    'public.clinical_slip_by_id(uuid)',
    'public.clinical_replace_slip(uuid,date,text,text)',
    'public.admin_prescription_template_editor(uuid)',
    'public.admin_save_prescription_template(uuid,jsonb,boolean)',
    'public.admin_clinical_records(uuid,boolean,integer,integer)',
    'public.admin_archive_transcription(uuid,boolean)',
    'public.admin_reverse_fulfilment(uuid,text)',
    'public.published_prescription_template(uuid)'
  ];
BEGIN
  SELECT jsonb_object_agg(expected.name, to_regclass('public.' || expected.name) IS NOT NULL)
  INTO v_tables
  FROM (VALUES
    ('patients'), ('persons'), ('camps'), ('camp_days'), ('profiles'),
    ('sms_deliveries'), ('public_rate_limit_buckets'),
    ('prescription_transcriptions'), ('prescription_corrections'),
    ('fulfilment_items'), ('fulfilment_events'), ('deferred_slips'),
    ('prescription_template_versions'), ('sponsor_assets'),
    ('aadhaar_extraction_events')
  ) AS expected(name);

  SELECT jsonb_object_agg(expected.table_name || '.' || expected.column_name,
    EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = expected.table_name
        AND c.column_name = expected.column_name
    ))
  INTO v_columns
  FROM (VALUES
    ('patients','id'), ('patients','status_token'), ('patients','queue_status'),
    ('patients','queued_at'), ('patients','printed_at'), ('patients','seen_at'),
    ('patients','seen_by'), ('patients','reg_no'), ('patients','camp_id'),
    ('patients','camp_day_id'), ('patients','full_name'), ('patients','display_name'),
    ('patients','person_id'), ('patients','provenance'), ('patients','phone_provenance'),
    ('persons','id'), ('persons','reg_no'), ('persons','full_name'),
    ('persons','display_name'), ('persons','gender'), ('persons','date_of_birth'),
    ('persons','aadhaar_last4'), ('persons','duplicate_key'),
    ('persons','aadhaar_locked_at'), ('persons','name_locked_at'),
    ('camps','id'), ('camps','name'), ('camps','is_active'), ('camps','venue'),
    ('camps','prescription_template'), ('camp_days','id'), ('camp_days','camp_id'),
    ('camp_days','day_date'), ('camp_days','seat_limit'), ('profiles','id'),
    ('profiles','role'), ('profiles','disabled_at'), ('profiles','team_lead_id'),
    ('sms_deliveries','id'), ('sms_deliveries','patient_id'), ('sms_deliveries','kind'),
    ('sms_deliveries','state'), ('sms_deliveries','claim_token'),
    ('sms_deliveries','phone_last4'), ('sms_deliveries','attempt_count'),
    ('sms_deliveries','dispatch_started_at'), ('sms_deliveries','updated_at'),
    ('public_rate_limit_buckets','scope'), ('public_rate_limit_buckets','key_hash'),
    ('public_rate_limit_buckets','window_started_at'),
    ('public_rate_limit_buckets','attempts'), ('public_rate_limit_buckets','expires_at'),
    ('prescription_transcriptions','id'), ('prescription_transcriptions','patient_id'),
    ('prescription_transcriptions','data'), ('prescription_transcriptions','paper_source'),
    ('prescription_transcriptions','created_by'), ('prescription_transcriptions','created_at'),
    ('prescription_transcriptions','updated_by'), ('prescription_transcriptions','updated_at'),
    ('prescription_transcriptions','locked_at'), ('prescription_transcriptions','archived_at'),
    ('prescription_corrections','id'), ('prescription_corrections','transcription_id'),
    ('prescription_corrections','reason'), ('prescription_corrections','correction_kind'),
    ('prescription_corrections','replacement_data'), ('prescription_corrections','created_by'),
    ('prescription_corrections','created_at'), ('fulfilment_items','id'),
    ('fulfilment_items','transcription_id'), ('fulfilment_items','kind'),
    ('fulfilment_items','outcome'), ('fulfilment_items','current_version'),
    ('fulfilment_items','resolved_by'), ('fulfilment_items','resolved_at'),
    ('fulfilment_events','id'), ('fulfilment_events','item_id'), ('fulfilment_events','event'),
    ('fulfilment_events','from_outcome'), ('fulfilment_events','to_outcome'),
    ('fulfilment_events','reason'), ('fulfilment_events','created_by'),
    ('fulfilment_events','created_at'), ('deferred_slips','id'), ('deferred_slips','item_id'),
    ('deferred_slips','reference'), ('deferred_slips','version'), ('deferred_slips','service'),
    ('deferred_slips','date_snapshot'), ('deferred_slips','venue_snapshot'),
    ('deferred_slips','issued_by'), ('deferred_slips','issued_at'), ('deferred_slips','status'),
    ('deferred_slips','replaced_by'), ('prescription_template_versions','id'),
    ('prescription_template_versions','camp_id'), ('prescription_template_versions','version'),
    ('prescription_template_versions','status'), ('prescription_template_versions','template'),
    ('prescription_template_versions','created_by'), ('prescription_template_versions','created_at'),
    ('prescription_template_versions','published_at'), ('sponsor_assets','id'),
    ('sponsor_assets','camp_id'), ('sponsor_assets','object_key'), ('sponsor_assets','mime_type'),
    ('sponsor_assets','byte_size'), ('sponsor_assets','created_by'), ('sponsor_assets','created_at'),
    ('sponsor_assets','state'), ('sponsor_assets','state_changed_at'),
    ('sponsor_assets','cleanup_attempts'), ('sponsor_assets','last_error_code'),
    ('aadhaar_extraction_events','id'), ('aadhaar_extraction_events','patient_id'),
    ('aadhaar_extraction_events','consent_at'), ('aadhaar_extraction_events','method'),
    ('aadhaar_extraction_events','trust_level'), ('aadhaar_extraction_events','outcome'),
    ('aadhaar_extraction_events','aadhaar_last4'), ('aadhaar_extraction_events','created_at')
  ) AS expected(table_name, column_name);

  SELECT jsonb_object_agg(expected.name, to_regprocedure(expected.signature) IS NOT NULL)
  INTO v_functions
  FROM (VALUES
    ('is_clinical_operator','public.is_clinical_operator()'),
    ('assert_valid_clinical_data','public.assert_valid_clinical_data(jsonb)'),
    ('clinical_lookup','public.clinical_lookup(uuid,integer)'),
    ('clinical_save_transcription','public.clinical_save_transcription(uuid,jsonb)'),
    ('clinical_add_correction','public.clinical_add_correction(uuid,jsonb,text)'),
    ('clinical_resolve_item','public.clinical_resolve_item(uuid,text,text)'),
    ('clinical_followup_fulfil','public.clinical_followup_fulfil(uuid)'),
    ('clinical_followup_lookup','public.clinical_followup_lookup(uuid,integer)'),
    ('clinical_slip_by_id','public.clinical_slip_by_id(uuid)'),
    ('clinical_replace_slip','public.clinical_replace_slip(uuid,date,text,text)'),
    ('admin_prescription_template_editor','public.admin_prescription_template_editor(uuid)'),
    ('admin_save_prescription_template','public.admin_save_prescription_template(uuid,jsonb,boolean)'),
    ('admin_clinical_records','public.admin_clinical_records(uuid,boolean,integer,integer)'),
    ('admin_archive_transcription','public.admin_archive_transcription(uuid,boolean)'),
    ('admin_reverse_fulfilment','public.admin_reverse_fulfilment(uuid,text)'),
    ('published_prescription_template','public.published_prescription_template(uuid)'),
    ('audit_scanned_aadhaar_registration','public.audit_scanned_aadhaar_registration()'),
    ('latest_applied_migration','public.latest_applied_migration()'),
    ('readiness_catalog_probe','public.readiness_catalog_probe()'),
    ('patient_status_by_token','public.patient_status_by_token(text)'),
    ('upsert_camp_day','public.upsert_camp_day(uuid,date,integer,uuid)'),
    ('register_patient_idempotent','public.register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean,boolean,text,text,date,text)'),
    ('check_in_patient','public.check_in_patient(uuid,integer)'),
    ('lookup_patient_scan','public.lookup_patient_scan(uuid,integer)'),
    ('mark_seen','public.mark_seen(uuid,integer)'),
    ('undo_mark_seen','public.undo_mark_seen(uuid)'),
    ('lookup_patient_status_token','public.lookup_patient_status_token(integer,date)'),
    ('consume_public_rate_limit','public.consume_public_rate_limit(text,text[],integer,integer)'),
    ('active_registration_id','public.active_registration_id(uuid,integer)'),
    ('staff_person_kpis','public.staff_person_kpis(uuid,text,uuid,text)'),
    ('claim_sms_delivery','public.claim_sms_delivery(uuid,public.sms_delivery_kind,text,integer)'),
    ('mark_sms_dispatch_started','public.mark_sms_dispatch_started(uuid,uuid)'),
    ('complete_sms_delivery','public.complete_sms_delivery(uuid,uuid,text,text,text)'),
    ('patient_registration_notify_fields','public.patient_registration_notify_fields(uuid)'),
    ('camp_queue_counts','public.camp_queue_counts(uuid)'),
    ('search_desk_patients','public.search_desk_patients(uuid,text,integer)'),
    ('desk_waiting_queue','public.desk_waiting_queue(uuid,integer)'),
    ('print_patient','public.print_patient(uuid)'),
    ('staff_registered_patients','public.staff_registered_patients(uuid,integer)'),
    ('begin_sponsor_asset_deletion','public.begin_sponsor_asset_deletion(uuid)'),
    ('finish_sponsor_asset_deletion','public.finish_sponsor_asset_deletion(uuid)')
  ) AS expected(name, signature);

  v_invariants := jsonb_build_object(
    'patients_camp_reg_no_unique', EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.patients'::regclass
        AND conname='patients_camp_reg_no_key' AND contype='u' AND convalidated
    ),
    'patients_person_camp_unique', EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.patients'::regclass
        AND conname='patients_person_camp_key' AND contype='u' AND convalidated
    ),
    'patients_person_id_not_null', EXISTS (
      SELECT 1 FROM pg_attribute WHERE attrelid='public.patients'::regclass
        AND attname='person_id' AND attnotnull AND NOT attisdropped
    ),
    'patients_provenance_current', EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.patients'::regclass
        AND conname='patients_provenance_check' AND convalidated
        AND pg_get_constraintdef(oid) LIKE '%self_declared%'
        AND pg_get_constraintdef(oid) LIKE '%card_scanned%'
        AND pg_get_constraintdef(oid) NOT LIKE '%ekyc_verified%'
    ),
    'retired_ekyc_storage_absent', NOT EXISTS (
      SELECT 1 FROM information_schema.columns WHERE table_schema='public'
        AND table_name='patients' AND column_name IN ('aadhaar_hash','aadhaar_verified_at','aadhaar_kyc_ref')
    ),
    'register_rpc_supported_signatures_only', (
      SELECT count(*)=1 AND bool_and(
        pg_get_function_arguments(p.oid) NOT ILIKE '%aadhaar_hash%'
        AND pg_get_function_arguments(p.oid) NOT ILIKE '%aadhaar_verified_at%'
        AND pg_get_function_arguments(p.oid) NOT ILIKE '%aadhaar_kyc_ref%'
      ) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='register_patient_idempotent'
    ) AND to_regprocedure('public.register_patient_v2(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean,text)') IS NULL,
    'patients_phone_provenance_current', EXISTS (
      SELECT 1 FROM information_schema.columns WHERE table_schema='public'
        AND table_name='patients' AND column_name='phone_provenance'
        AND is_nullable='NO' AND column_default LIKE '%self_declared%'
    ) AND EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.patients'::regclass
        AND conname='patients_phone_provenance_check' AND contype='c' AND convalidated
    ),
    'staff_kpi_single_contract', (
      SELECT count(*)=1 AND bool_and(p.oid=to_regprocedure('public.staff_person_kpis(uuid,text,uuid,text)'))
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='staff_person_kpis'
    ),
    'staff_leaderboard_absent', to_regprocedure('public.staff_leaderboard(uuid,uuid)') IS NULL,
    'migration_head_current', public.latest_applied_migration() = '20260805100000',
    'profiles_team_lead_fk', EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.profiles'::regclass
        AND conname='profiles_team_lead_id_fkey' AND contype='f' AND convalidated
    ),
    'team_membership_guards', (
      SELECT count(*)=2 AND bool_and(tgenabled <> 'D') FROM pg_trigger
      WHERE tgrelid='public.profiles'::regclass AND NOT tgisinternal
        AND tgname IN ('validate_profile_team_membership','release_disabled_team_members')
    ),
    'prescription_records_absent', to_regclass('public.prescriptions') IS NULL
      AND to_regclass('public.treatment_orders') IS NULL
      AND to_regclass('public.prescription_amendments') IS NULL,
    'doctor_station_retired', to_regprocedure('public.assign_patient_doctor(uuid,integer,uuid)') IS NULL
      AND to_regprocedure('public.is_doctor()') IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.profiles WHERE role='doctor'::public.user_role AND disabled_at IS NULL),
    'mark_seen_contract', to_regprocedure('public.mark_seen(uuid,integer)') IS NOT NULL
      AND to_regprocedure('public.undo_mark_seen(uuid)') IS NOT NULL,
    'public_rate_limit_primary_key', EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.public_rate_limit_buckets'::regclass
        AND conname='public_rate_limit_buckets_pkey' AND contype='p' AND convalidated
    ),
    'transcription_patient_unique', EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.prescription_transcriptions'::regclass
        AND contype='u' AND pg_get_constraintdef(oid) LIKE '%(patient_id)%' AND convalidated
    ),
    'fulfilment_kind_unique', EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.fulfilment_items'::regclass
        AND contype='u' AND pg_get_constraintdef(oid) LIKE '%(transcription_id, kind)%' AND convalidated
    ),
    'deferred_one_active', to_regclass('public.deferred_slips_one_active') IS NOT NULL,
    'template_one_published', to_regclass('public.prescription_template_one_published') IS NOT NULL,
    'template_one_draft', to_regclass('public.prescription_template_one_draft') IS NOT NULL,
    'sponsor_object_key_unique', EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.sponsor_assets'::regclass
        AND contype='u' AND pg_get_constraintdef(oid) LIKE '%(object_key)%' AND convalidated
    ),
    'sponsor_state_check', EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.sponsor_assets'::regclass
        AND conname='sponsor_assets_state_check' AND convalidated
        AND pg_get_constraintdef(oid) LIKE '%pending%'
        AND pg_get_constraintdef(oid) LIKE '%ready%'
        AND pg_get_constraintdef(oid) LIKE '%deleting%'
    ),
    'aadhaar_event_patient_unique', EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid='public.aadhaar_extraction_events'::regclass
        AND contype='u' AND pg_get_constraintdef(oid) LIKE '%(patient_id)%' AND convalidated
    ),
    'clinical_rls_enabled', (
      SELECT bool_and(relrowsecurity) FROM pg_class
      WHERE oid IN ('public.prescription_transcriptions'::regclass,
        'public.prescription_corrections'::regclass,'public.fulfilment_items'::regclass,
        'public.fulfilment_events'::regclass,'public.deferred_slips'::regclass,
        'public.prescription_template_versions'::regclass,'public.sponsor_assets'::regclass,
        'public.aadhaar_extraction_events'::regclass)
    ),
    'sponsor_bucket_private', EXISTS (
      SELECT 1 FROM storage.buckets WHERE id='prescription-sponsors' AND public=false
    ),
    'sponsor_bucket_restrictions', EXISTS (
      SELECT 1 FROM storage.buckets
      WHERE id='prescription-sponsors' AND file_size_limit=2097152
        AND cardinality(allowed_mime_types)=3
        AND allowed_mime_types @> ARRAY['image/png','image/jpeg','image/webp']::text[]
    )
  );

  v_grants := jsonb_build_object(
    'patients_status_token_authenticated_select', has_column_privilege('authenticated','public.patients','status_token','SELECT'),
    'patient_status_by_token_authenticated_execute', has_function_privilege('authenticated','public.patient_status_by_token(text)','EXECUTE'),
    'patient_status_by_token_anon_execute', has_function_privilege('anon','public.patient_status_by_token(text)','EXECUTE'),
    'patient_status_by_token_service_role_execute', has_function_privilege('service_role','public.patient_status_by_token(text)','EXECUTE'),
    'sms_deliveries_authenticated_select', has_table_privilege('authenticated','public.sms_deliveries','SELECT'),
    'claim_sms_delivery_service_role_execute', has_function_privilege('service_role','public.claim_sms_delivery(uuid,public.sms_delivery_kind,text,integer)','EXECUTE'),
    'complete_sms_delivery_service_role_execute', has_function_privilege('service_role','public.complete_sms_delivery(uuid,uuid,text,text,text)','EXECUTE'),
    'upsert_camp_day_authenticated_execute', has_function_privilege('authenticated','public.upsert_camp_day(uuid,date,integer,uuid)','EXECUTE'),
    'check_in_patient_authenticated_execute', has_function_privilege('authenticated','public.check_in_patient(uuid,integer)','EXECUTE'),
    'lookup_patient_scan_authenticated_execute', has_function_privilege('authenticated','public.lookup_patient_scan(uuid,integer)','EXECUTE'),
    'search_desk_patients_authenticated_execute', has_function_privilege('authenticated','public.search_desk_patients(uuid,text,integer)','EXECUTE'),
    'search_desk_patients_anon_execute', has_function_privilege('anon','public.search_desk_patients(uuid,text,integer)','EXECUTE'),
    'mark_seen_authenticated_execute', has_function_privilege('authenticated','public.mark_seen(uuid,integer)','EXECUTE'),
    'mark_seen_anon_execute', has_function_privilege('anon','public.mark_seen(uuid,integer)','EXECUTE'),
    'undo_mark_seen_authenticated_execute', has_function_privilege('authenticated','public.undo_mark_seen(uuid)','EXECUTE'),
    'register_patient_idempotent_authenticated_execute', has_function_privilege('authenticated','public.register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean,boolean,text,text,date,text)','EXECUTE'),
    'lookup_patient_status_token_anon_execute', has_function_privilege('anon','public.lookup_patient_status_token(integer,date)','EXECUTE'),
    'lookup_patient_status_token_authenticated_execute', has_function_privilege('authenticated','public.lookup_patient_status_token(integer,date)','EXECUTE'),
    'lookup_patient_status_token_service_role_execute', has_function_privilege('service_role','public.lookup_patient_status_token(integer,date)','EXECUTE'),
    'consume_public_rate_limit_anon_execute', has_function_privilege('anon','public.consume_public_rate_limit(text,text[],integer,integer)','EXECUTE'),
    'consume_public_rate_limit_authenticated_execute', has_function_privilege('authenticated','public.consume_public_rate_limit(text,text[],integer,integer)','EXECUTE'),
    'consume_public_rate_limit_service_role_execute', has_function_privilege('service_role','public.consume_public_rate_limit(text,text[],integer,integer)','EXECUTE'),
    'staff_person_kpis_authenticated_execute', has_function_privilege('authenticated','public.staff_person_kpis(uuid,text,uuid,text)','EXECUTE'),
    'staff_person_kpis_anon_execute', has_function_privilege('anon','public.staff_person_kpis(uuid,text,uuid,text)','EXECUTE'),
    'staff_person_kpis_service_role_execute', has_function_privilege('service_role','public.staff_person_kpis(uuid,text,uuid,text)','EXECUTE'),
    'staff_leaderboard_authenticated_execute', to_regprocedure('public.staff_leaderboard(uuid,uuid)') IS NOT NULL,
    'mark_sms_dispatch_started_authenticated_execute', has_function_privilege('authenticated','public.mark_sms_dispatch_started(uuid,uuid)','EXECUTE'),
    'mark_sms_dispatch_started_service_role_execute', has_function_privilege('service_role','public.mark_sms_dispatch_started(uuid,uuid)','EXECUTE'),
    'patient_registration_notify_fields_authenticated_execute', has_function_privilege('authenticated','public.patient_registration_notify_fields(uuid)','EXECUTE'),
    'camp_queue_counts_authenticated_execute', has_function_privilege('authenticated','public.camp_queue_counts(uuid)','EXECUTE'),
    'camp_queue_counts_anon_execute', has_function_privilege('anon','public.camp_queue_counts(uuid)','EXECUTE'),
    'camp_queue_counts_service_role_execute', has_function_privilege('service_role','public.camp_queue_counts(uuid)','EXECUTE'),
    'latest_applied_migration_service_role_execute', has_function_privilege('service_role','public.latest_applied_migration()','EXECUTE'),
    'persons_authenticated_select', has_table_privilege('authenticated','public.persons','SELECT'),
    'persons_authenticated_write', has_table_privilege('authenticated','public.persons','INSERT') OR has_table_privilege('authenticated','public.persons','UPDATE'),
    'patients_authenticated_select', has_table_privilege('authenticated','public.patients','SELECT'),
    'prescription_transcriptions_authenticated_write', has_table_privilege('authenticated','public.prescription_transcriptions','INSERT') OR has_table_privilege('authenticated','public.prescription_transcriptions','UPDATE') OR has_table_privilege('authenticated','public.prescription_transcriptions','DELETE'),
    'prescription_corrections_authenticated_write', has_table_privilege('authenticated','public.prescription_corrections','INSERT') OR has_table_privilege('authenticated','public.prescription_corrections','UPDATE') OR has_table_privilege('authenticated','public.prescription_corrections','DELETE'),
    'fulfilment_items_authenticated_write', has_table_privilege('authenticated','public.fulfilment_items','INSERT') OR has_table_privilege('authenticated','public.fulfilment_items','UPDATE') OR has_table_privilege('authenticated','public.fulfilment_items','DELETE'),
    'fulfilment_events_authenticated_write', has_table_privilege('authenticated','public.fulfilment_events','INSERT') OR has_table_privilege('authenticated','public.fulfilment_events','UPDATE') OR has_table_privilege('authenticated','public.fulfilment_events','DELETE'),
    'deferred_slips_authenticated_write', has_table_privilege('authenticated','public.deferred_slips','INSERT') OR has_table_privilege('authenticated','public.deferred_slips','UPDATE') OR has_table_privilege('authenticated','public.deferred_slips','DELETE'),
    'prescription_template_versions_authenticated_write', has_table_privilege('authenticated','public.prescription_template_versions','INSERT') OR has_table_privilege('authenticated','public.prescription_template_versions','UPDATE') OR has_table_privilege('authenticated','public.prescription_template_versions','DELETE'),
    'sponsor_assets_authenticated_write', has_table_privilege('authenticated','public.sponsor_assets','INSERT') OR has_table_privilege('authenticated','public.sponsor_assets','UPDATE') OR has_table_privilege('authenticated','public.sponsor_assets','DELETE'),
    'aadhaar_extraction_events_authenticated_write', has_table_privilege('authenticated','public.aadhaar_extraction_events','INSERT') OR has_table_privilege('authenticated','public.aadhaar_extraction_events','UPDATE') OR has_table_privilege('authenticated','public.aadhaar_extraction_events','DELETE'),
    'aadhaar_extraction_events_authenticated_access', has_table_privilege('authenticated','public.aadhaar_extraction_events','SELECT') OR has_table_privilege('authenticated','public.aadhaar_extraction_events','INSERT') OR has_table_privilege('authenticated','public.aadhaar_extraction_events','UPDATE') OR has_table_privilege('authenticated','public.aadhaar_extraction_events','DELETE'),
    'prescription_transcriptions_anon_access', has_table_privilege('anon','public.prescription_transcriptions','SELECT') OR has_table_privilege('anon','public.prescription_transcriptions','INSERT') OR has_table_privilege('anon','public.prescription_transcriptions','UPDATE') OR has_table_privilege('anon','public.prescription_transcriptions','DELETE'),
    'prescription_corrections_anon_access', has_table_privilege('anon','public.prescription_corrections','SELECT') OR has_table_privilege('anon','public.prescription_corrections','INSERT') OR has_table_privilege('anon','public.prescription_corrections','UPDATE') OR has_table_privilege('anon','public.prescription_corrections','DELETE'),
    'fulfilment_items_anon_access', has_table_privilege('anon','public.fulfilment_items','SELECT') OR has_table_privilege('anon','public.fulfilment_items','INSERT') OR has_table_privilege('anon','public.fulfilment_items','UPDATE') OR has_table_privilege('anon','public.fulfilment_items','DELETE'),
    'fulfilment_events_anon_access', has_table_privilege('anon','public.fulfilment_events','SELECT') OR has_table_privilege('anon','public.fulfilment_events','INSERT') OR has_table_privilege('anon','public.fulfilment_events','UPDATE') OR has_table_privilege('anon','public.fulfilment_events','DELETE'),
    'deferred_slips_anon_access', has_table_privilege('anon','public.deferred_slips','SELECT') OR has_table_privilege('anon','public.deferred_slips','INSERT') OR has_table_privilege('anon','public.deferred_slips','UPDATE') OR has_table_privilege('anon','public.deferred_slips','DELETE'),
    'prescription_template_versions_anon_access', has_table_privilege('anon','public.prescription_template_versions','SELECT') OR has_table_privilege('anon','public.prescription_template_versions','INSERT') OR has_table_privilege('anon','public.prescription_template_versions','UPDATE') OR has_table_privilege('anon','public.prescription_template_versions','DELETE'),
    'sponsor_assets_anon_access', has_table_privilege('anon','public.sponsor_assets','SELECT') OR has_table_privilege('anon','public.sponsor_assets','INSERT') OR has_table_privilege('anon','public.sponsor_assets','UPDATE') OR has_table_privilege('anon','public.sponsor_assets','DELETE'),
    'aadhaar_extraction_events_anon_access', has_table_privilege('anon','public.aadhaar_extraction_events','SELECT') OR has_table_privilege('anon','public.aadhaar_extraction_events','INSERT') OR has_table_privilege('anon','public.aadhaar_extraction_events','UPDATE') OR has_table_privilege('anon','public.aadhaar_extraction_events','DELETE'),
    'clinical_callable_authenticated_execute', (SELECT coalesce(bool_and(has_function_privilege('authenticated', sig, 'EXECUTE')), true) FROM unnest(v_clinical_signatures) sig),
    'clinical_callable_service_role_execute', (SELECT coalesce(bool_and(has_function_privilege('service_role', sig, 'EXECUTE')), true) FROM unnest(v_clinical_signatures) sig),
    'clinical_internal_anon_execute', (SELECT coalesce(bool_or(has_function_privilege('anon', sig, 'EXECUTE')), false) FROM unnest(v_clinical_signatures) sig),
    'clinical_callable_public_execute', (SELECT coalesce(bool_or(has_function_privilege('anon', sig, 'EXECUTE')), false) FROM unnest(v_clinical_signatures) sig),
    'assert_valid_clinical_data_authenticated_execute', has_function_privilege('authenticated','public.assert_valid_clinical_data(jsonb)','EXECUTE'),
    'assert_valid_clinical_data_anon_execute', has_function_privilege('anon','public.assert_valid_clinical_data(jsonb)','EXECUTE'),
    'assert_valid_clinical_data_service_role_execute', has_function_privilege('service_role','public.assert_valid_clinical_data(jsonb)','EXECUTE'),
    'audit_scanned_aadhaar_authenticated_execute', has_function_privilege('authenticated','public.audit_scanned_aadhaar_registration()','EXECUTE'),
    'audit_scanned_aadhaar_anon_execute', has_function_privilege('anon','public.audit_scanned_aadhaar_registration()','EXECUTE'),
    'audit_scanned_aadhaar_service_role_execute', has_function_privilege('service_role','public.audit_scanned_aadhaar_registration()','EXECUTE'),
    'desk_waiting_queue_authenticated_execute', has_function_privilege('authenticated','public.desk_waiting_queue(uuid,integer)','EXECUTE'),
    'print_patient_authenticated_execute', has_function_privilege('authenticated','public.print_patient(uuid)','EXECUTE'),
    'staff_registered_patients_authenticated_execute', has_function_privilege('authenticated','public.staff_registered_patients(uuid,integer)','EXECUTE'),
    'begin_sponsor_asset_deletion_authenticated_execute', has_function_privilege('authenticated','public.begin_sponsor_asset_deletion(uuid)','EXECUTE'),
    'finish_sponsor_asset_deletion_authenticated_execute', has_function_privilege('authenticated','public.finish_sponsor_asset_deletion(uuid)','EXECUTE')
  );

  SELECT jsonb_object_agg(expected.name, EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
    JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' AND t.typname='sms_delivery_state' AND e.enumlabel=expected.name
  )) INTO v_states
  FROM (VALUES ('pending'),('sending'),('sent'),('failed'),('ambiguous')) expected(name);

  SELECT jsonb_object_agg(expected.name, EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
    JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' AND t.typname='sms_delivery_kind' AND e.enumlabel=expected.name
  )) INTO v_kinds
  FROM (VALUES ('registration'),('reminder')) expected(name);

  RETURN jsonb_build_object(
    'tables', v_tables,
    'columns', v_columns,
    'functions', v_functions,
    'invariants', v_invariants,
    'grants', v_grants,
    'publication', jsonb_build_object('patients_in_supabase_realtime', EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='patients'
    )),
    'sms', jsonb_build_object(
      'table', to_regclass('public.sms_deliveries') IS NOT NULL,
      'states', v_states,
      'kinds', v_kinds,
      'claim_fn', to_regprocedure('public.claim_sms_delivery(uuid,public.sms_delivery_kind,text,integer)') IS NOT NULL,
      'complete_fn', to_regprocedure('public.complete_sms_delivery(uuid,uuid,text,text,text)') IS NOT NULL
    )
  );
END;
$function$;

ALTER FUNCTION public.readiness_catalog_probe() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.readiness_catalog_probe() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_catalog_probe() TO service_role;

-- Fail the migration rather than leave a false-green catalog if a prior
-- environment still has an old KPI overload or the new RPCs are absent.
DO $verify$
BEGIN
  IF to_regprocedure('public.staff_person_kpis(uuid,text,uuid,timestamptz,text)') IS NOT NULL
     OR to_regprocedure('public.staff_person_kpis(uuid,text,uuid,text)') IS NULL
     OR to_regprocedure('public.desk_waiting_queue(uuid,integer)') IS NULL
     OR to_regprocedure('public.print_patient(uuid)') IS NULL
     OR to_regprocedure('public.staff_registered_patients(uuid,integer)') IS NULL
  THEN
    RAISE EXCEPTION 'audit Batch 2 RPC catalog is incomplete';
  END IF;
END $verify$;
