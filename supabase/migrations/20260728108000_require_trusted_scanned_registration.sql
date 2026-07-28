-- A browser-authenticated caller must not choose a Person duplicate key.
-- Scanned-card registrations cross the server-only route, which derives the
-- HMAC and invokes this function as service_role with the real staff creator.
do $migration$
declare
  v_signature regprocedure :=
    to_regprocedure(
      'public.register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean,boolean,text,timestamptz,text,text,text,date,text)'
    );
  v_definition text;
  v_marker text :=
    E'elsif v_request_role = ''authenticated'' then\n    if not exists (';
  v_replacement text :=
    E'elsif v_request_role = ''authenticated'' then\n    if p_duplicate_key is not null and length(trim(p_duplicate_key)) > 0 then\n      raise exception ''scanned registration requires trusted server'';\n    end if;\n    if not exists (';
begin
  if v_signature is null then
    raise exception 'register_patient_idempotent full signature is missing';
  end if;

  select pg_get_functiondef(v_signature) into v_definition;

  if strpos(v_definition, v_marker) = 0 then
    raise exception 'register_patient_idempotent authenticated branch changed; trusted scan guard not applied';
  end if;

  execute replace(v_definition, v_marker, v_replacement);
end
$migration$;
