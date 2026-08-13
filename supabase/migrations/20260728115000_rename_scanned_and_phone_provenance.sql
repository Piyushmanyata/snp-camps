-- #113 / ADR 0004: a QR scan records where data came from. It does not
-- cryptographically verify either the card or the person presenting it.

ALTER TABLE public.patients
  DROP CONSTRAINT patients_provenance_check;

UPDATE public.patients
SET provenance = 'card_scanned'
WHERE provenance = 'card_verified';

ALTER TABLE public.patients
  ADD COLUMN phone_provenance text NOT NULL DEFAULT 'self_declared',
  ADD CONSTRAINT patients_provenance_check
    CHECK (provenance IN ('self_declared', 'card_scanned')),
  ADD CONSTRAINT patients_phone_provenance_check
    CHECK (phone_provenance = 'self_declared');

COMMENT ON COLUMN public.patients.provenance IS
  'Source of registration identity fields: self_declared or card_scanned. A scan is parsed and trusted, not cryptographically verified.';
COMMENT ON COLUMN public.patients.phone_provenance IS
  'Phone contact is independently typed and self-declared; Aadhaar QR data contains no phone number and no phone verification is performed.';

-- Replace the retired term in every live public routine. This keeps the large,
-- concurrency-sensitive registration implementation intact while making its
-- accepted input, validation errors, and persisted values strictly
-- card_scanned. Historical migration files remain immutable.
DO $migration$
DECLARE
  v_function record;
  v_definition text;
  v_anchor text;
  v_changed integer := 0;
BEGIN
  FOR v_function IN
    SELECT p.oid
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND pg_get_functiondef(p.oid) LIKE '%card_verified%'
  LOOP
    v_definition := pg_get_functiondef(v_function.oid);
    v_definition := replace(v_definition, 'card_verified', 'card_scanned');

    -- The schema migration may reach production just before the application
    -- deployment. Temporarily accept the old request value at the canonical
    -- RPC boundary, but normalize before validation and INSERT so storage is
    -- card_scanned-only throughout the rollout.
    IF v_function.oid = to_regprocedure(
      'public.register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean,boolean,text,text,date,text)'
    ) THEN
      v_anchor :=
        'v_provenance text := lower(btrim(coalesce(p_provenance, ''self_declared'')));';
      IF strpos(v_definition, v_anchor) = 0 THEN
        RAISE EXCEPTION 'Canonical provenance normalization anchor not found';
      END IF;
      v_definition := replace(
        v_definition,
        v_anchor,
        'v_provenance text := CASE'
          || E'\n    WHEN lower(btrim(coalesce(p_provenance, ''self_declared''))) = ''card_verified'''
          || E'\n      THEN ''card_scanned'''
          || E'\n    ELSE lower(btrim(coalesce(p_provenance, ''self_declared'')))'
          || E'\n  END;'
      );
    END IF;

    EXECUTE v_definition;
    v_changed := v_changed + 1;
  END LOOP;

  IF v_changed = 0 THEN
    RAISE EXCEPTION 'Expected live card_verified routine semantics to replace';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND pg_get_functiondef(p.oid) LIKE '%card_verified%'
  ) <> 1
  OR pg_get_functiondef(
    'public.register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean,boolean,text,text,date,text)'::regprocedure
  ) NOT LIKE '%WHEN lower(btrim(coalesce(p_provenance,%card_verified%'
  THEN
    RAISE EXCEPTION 'Legacy provenance input must exist only in the canonical rollout normalizer';
  END IF;
END
$migration$;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.patients
    WHERE provenance NOT IN ('self_declared', 'card_scanned')
       OR phone_provenance <> 'self_declared'
  ) THEN
    RAISE EXCEPTION 'Patient provenance backfill is incomplete';
  END IF;
END
$migration$;
