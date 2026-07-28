-- #55: Team Leads have every volunteer desk power. Patch only the two proven
-- implementations that still carried pre-Team-Lead role allowlists. Exact
-- source guards make replay fail loudly if an earlier definition ever drifts.

DO $migration$
DECLARE
  v_signature regprocedure;
  v_definition text;
  v_original text;
BEGIN
  v_signature :=
    'public.register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean,boolean,text,timestamp with time zone,text,text,text,date,text)'::regprocedure;
  SELECT pg_get_functiondef(v_signature) INTO v_definition;
  v_original := v_definition;
  v_definition := replace(
    v_definition,
    'p.role in (''admin'', ''volunteer'')',
    'p.role in (''admin'', ''team_lead'', ''volunteer'')'
  );
  v_definition := replace(
    v_definition,
    'active admin or volunteer required',
    'active staff member required'
  );
  IF v_definition = v_original THEN
    RAISE EXCEPTION
      'register_patient_idempotent role guard did not match expected source';
  END IF;
  EXECUTE v_definition;

  v_signature :=
    'public.assign_patient_doctor_registration_impl(uuid,integer,uuid)'::regprocedure;
  SELECT pg_get_functiondef(v_signature) INTO v_definition;
  v_original := v_definition;
  v_definition := replace(
    v_definition,
    'p.role in (''admin'', ''volunteer'', ''doctor'')',
    'p.role in (''admin'', ''team_lead'', ''volunteer'', ''doctor'')'
  );
  IF v_definition = v_original THEN
    RAISE EXCEPTION
      'assign_patient_doctor role guard did not match expected source';
  END IF;
  EXECUTE v_definition;
END
$migration$;
