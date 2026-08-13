-- Issue #128: Camp Records / Clinical Audit export, stored diagnoses split,
-- and itemised unavailable medicines on Medicine fulfilment.

-- ---------------------------------------------------------------------------
-- Schema: unavailable medicines on fulfilment items
-- ---------------------------------------------------------------------------
alter table public.fulfilment_items
  add column if not exists unavailable_medicines text[];

alter table public.fulfilment_items
  drop constraint if exists fulfilment_items_unavailable_medicines_check;

-- Per-item length is enforced in clinical_resolve_item (CHECK cannot use subqueries).
alter table public.fulfilment_items
  add constraint fulfilment_items_unavailable_medicines_check
  check (
    unavailable_medicines is null
    or cardinality(unavailable_medicines) between 1 and 12
  );

-- ---------------------------------------------------------------------------
-- Diagnoses: accept {options, other} or legacy flat array
-- ---------------------------------------------------------------------------
create or replace function public.assert_valid_clinical_data(p_data jsonb)
returns void language plpgsql immutable
set search_path to pg_catalog, public as $$
declare
  v_value text;
  v_eye jsonb;
  v_key text;
  v_options jsonb;
  v_other text;
  v_total integer;
begin
  if jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>32768 then
    raise exception 'valid diagnosis options are required';
  end if;

  if jsonb_typeof(p_data->'diagnoses') = 'object' then
    v_options := p_data->'diagnoses'->'options';
    if jsonb_typeof(v_options) is distinct from 'array'
       or exists (
         select 1 from jsonb_array_elements(v_options) diagnosis
         where jsonb_typeof(diagnosis)<>'string'
            or char_length(btrim(diagnosis#>>'{}')) not between 1 and 120
       )
    then
      raise exception 'valid diagnosis options are required';
    end if;
    v_other := nullif(btrim(coalesce(p_data->'diagnoses'->>'other','')),'');
    if v_other is not null and char_length(v_other) > 120 then
      raise exception 'valid diagnosis options are required';
    end if;
    v_total := jsonb_array_length(v_options) + case when v_other is null then 0 else 1 end;
    if v_total not between 1 and 12 then
      raise exception 'valid diagnosis options are required';
    end if;
  elsif jsonb_typeof(p_data->'diagnoses') = 'array' then
    if jsonb_array_length(p_data->'diagnoses') not between 1 and 12
       or exists (
         select 1 from jsonb_array_elements(p_data->'diagnoses') diagnosis
         where jsonb_typeof(diagnosis)<>'string'
            or char_length(btrim(diagnosis#>>'{}')) not between 1 and 120
       )
    then
      raise exception 'valid diagnosis options are required';
    end if;
  else
    raise exception 'valid diagnosis options are required';
  end if;

  if char_length(coalesce(p_data->>'remarks',''))>2000
     or char_length(coalesce(p_data->>'medicines',''))>2000
     or char_length(coalesce(p_data->>'bloodSugar',''))>32
     or char_length(coalesce(p_data->>'bloodPressure',''))>32
     then raise exception 'clinical text is too long'; end if;
  v_value:=nullif(btrim(p_data->>'bloodSugar'),'');
  if v_value is not null and (v_value !~ '^[0-9]+([.][0-9]+)?$'
     or v_value::numeric not between 20 and 1000)
     then raise exception 'blood sugar is outside the accepted range'; end if;
  v_value:=nullif(btrim(p_data->>'bloodPressure'),'');
  if v_value is not null and (v_value !~ '^[0-9]{2,3}/[0-9]{2,3}$'
     or split_part(v_value,'/',1)::integer not between 40 and 300
     or split_part(v_value,'/',2)::integer not between 30 and 200)
     then raise exception 'blood pressure must be systolic/diastolic'; end if;
  if p_data->'specs' is not null and p_data->'specs'<>'null'::jsonb then
    if jsonb_typeof(p_data->'specs')<>'object'
       or p_data->'specs'->>'type' not in ('distance','near','bifocal','progressive','fixed_power')
       or jsonb_typeof(p_data->'specs'->'right')<>'object'
       or jsonb_typeof(p_data->'specs'->'left')<>'object'
       or coalesce(p_data->'specs'->'right'->>'sphere','') !~ '^-?[0-9]+([.][0-9]+)?$'
       or coalesce(p_data->'specs'->'left'->>'sphere','') !~ '^-?[0-9]+([.][0-9]+)?$'
       or coalesce(p_data->'specs'->>'pd','') !~ '^[0-9]+([.][0-9]+)?$'
       or (p_data->'specs'->>'pd')::numeric not between 30 and 80
       then raise exception 'valid Specs type, both eyes, and PD are required'; end if;
    foreach v_eye in array array[p_data->'specs'->'right',p_data->'specs'->'left'] loop
      foreach v_key in array array['sphere','cylinder','near','nearAddition'] loop
        v_value:=nullif(btrim(v_eye->>v_key),'');
        if v_value is not null and (v_value !~ '^-?[0-9]+([.][0-9]+)?$'
          or v_value::numeric not between -30 and 30)
          then raise exception 'Specs power is outside the accepted range'; end if;
      end loop;
      v_value:=nullif(btrim(v_eye->>'axis'),'');
      if v_value is not null and (v_value !~ '^[0-9]+$' or v_value::integer not between 0 and 180)
        then raise exception 'Specs axis must be between 0 and 180'; end if;
      if char_length(coalesce(v_eye->>'vision',''))>32
        then raise exception 'Specs vision text is too long'; end if;
    end loop;
  end if;
  if p_data->'ot' is not null and p_data->'ot'<>'null'::jsonb and (
    jsonb_typeof(p_data->'ot')<>'object'
    or p_data->'ot'->>'eye' not in ('right','left','both')
    or char_length(btrim(coalesce(p_data->'ot'->>'procedure',''))) not between 1 and 200
    or char_length(coalesce(p_data->'ot'->>'notes',''))>1000
  ) then raise exception 'valid OT eye and procedure are required'; end if;
end $$;

revoke all on function public.assert_valid_clinical_data(jsonb) from public, anon, authenticated;
grant execute on function public.assert_valid_clinical_data(jsonb) to service_role, postgres;

-- ---------------------------------------------------------------------------
-- clinical_resolve_item: optional unavailable medicines list
-- ---------------------------------------------------------------------------
drop function if exists public.clinical_resolve_item(uuid, text, text);

create or replace function public.clinical_resolve_item(
  p_patient_id uuid,
  p_kind text,
  p_outcome text,
  p_unavailable_medicines text[] default null
) returns jsonb language plpgsql security definer
set search_path to pg_catalog, public as $$
declare
  v_actor uuid := (select auth.uid());
  v_t public.prescription_transcriptions;
  v_item public.fulfilment_items;
  v_camp public.camps%rowtype;
  v_date date;
  v_venue text;
  v_slip public.deferred_slips;
  v_data jsonb;
  v_meds text[];
  v_reason text;
begin
  if not public.is_clinical_operator() then raise exception 'clinical operator only'; end if;
  select t.* into v_t from public.prescription_transcriptions t
    join public.patients p on p.id=t.patient_id
    join public.camps c on c.id=p.camp_id
    where p.id=p_patient_id and p.queue_status='seen' and c.is_active
    for update of t;
  if not found then raise exception 'seen transcription required'; end if;
  select coalesce((
    select c.replacement_data from public.prescription_corrections c
    where c.transcription_id=v_t.id and c.correction_kind='clinical'
    order by c.created_at desc limit 1
  ),v_t.data) into v_data;
  if p_kind='medicine' and p_outcome<>'not_required'
     and nullif(btrim(v_data->>'medicines'),'') is null
     then raise exception 'medicine detail is required for this outcome'; end if;
  if p_kind='specs' and p_outcome<>'not_required'
     and (v_data->'specs' is null or v_data->'specs'='null'::jsonb)
     then raise exception 'Specs measurements are required for this outcome'; end if;
  if p_kind='ot' and p_outcome<>'not_required'
     and (v_data->'ot' is null or v_data->'ot'='null'::jsonb)
     then raise exception 'OT detail is required for this outcome'; end if;

  v_meds := null;
  if p_kind='medicine' and p_outcome='not_available' then
    if p_unavailable_medicines is null
       or cardinality(p_unavailable_medicines) not between 1 and 12
       or exists (
         select 1 from unnest(p_unavailable_medicines) med
         where char_length(btrim(med)) not between 1 and 120
       )
    then
      raise exception 'unavailable medicines are required for this outcome';
    end if;
    select array_agg(btrim(med)) into v_meds from unnest(p_unavailable_medicines) med;
    v_reason := array_to_string(v_meds, '; ');
  elsif p_unavailable_medicines is not null then
    raise exception 'unavailable medicines only apply to medicine not_available';
  end if;

  insert into public.fulfilment_items(
    transcription_id, kind, outcome, resolved_by, unavailable_medicines
  )
    values(v_t.id, p_kind, p_outcome, v_actor, v_meds)
  on conflict (transcription_id, kind) do nothing returning * into v_item;
  if v_item.id is null then
    select * into v_item from public.fulfilment_items
      where transcription_id=v_t.id and kind=p_kind;
    if v_item.outcome <> p_outcome then raise exception 'outcome conflict'; end if;
  else
    update public.prescription_transcriptions set locked_at=coalesce(locked_at,now())
      where id=v_t.id;
    insert into public.fulfilment_events(item_id,event,to_outcome,reason,created_by)
      values(v_item.id,'resolved',p_outcome,v_reason,v_actor);
  end if;
  if p_outcome='deferred' then
    select c.* into v_camp from public.camps c join public.patients p on p.camp_id=c.id
      where p.id=p_patient_id;
    if p_kind='specs' then
      v_date:=v_camp.spectacles_collection_date; v_venue:=v_camp.spectacles_collection_venue;
    elsif p_kind='ot' then
      v_date:=v_camp.post_camp_surgery_date; v_venue:=v_camp.post_camp_surgery_venue;
    else raise exception 'medicine cannot be deferred'; end if;
    if v_date is null or nullif(btrim(v_venue),'') is null then
      raise exception 'matching deferred date and venue are required';
    end if;
    insert into public.deferred_slips(item_id,reference,version,service,date_snapshot,
      venue_snapshot,issued_by)
      values(v_item.id,upper(substr(p_kind,1,1))||'-'||substr(replace(v_item.id::text,'-',''),1,10),
        1,p_kind,v_date,v_venue,v_actor)
      on conflict do nothing returning * into v_slip;
    if v_slip.id is null then select * into v_slip from public.deferred_slips
      where item_id=v_item.id and status='active'; end if;
  end if;
  return jsonb_build_object('item',to_jsonb(v_item),'slip',to_jsonb(v_slip));
end $$;

revoke all on function public.clinical_resolve_item(uuid,text,text,text[]) from public, anon;
grant execute on function public.clinical_resolve_item(uuid,text,text,text[])
  to authenticated, service_role, postgres;

-- ---------------------------------------------------------------------------
-- admin_clinical_export — full-camp records or audit events
-- ---------------------------------------------------------------------------
create or replace function public.admin_clinical_export(
  p_camp_id uuid default null,
  p_format text default 'records',
  p_include_archived boolean default false
) returns jsonb language plpgsql stable security definer
set search_path to pg_catalog, public as $$
declare
  v_camp public.camps%rowtype;
  v_options text[] := array[]::text[];
  v_template jsonb;
  v_rows jsonb;
  v_jwt_role text := coalesce(auth.role(), '');
begin
  if not (public.is_admin() or v_jwt_role = 'service_role') then
    raise exception 'admin only';
  end if;
  if p_format is distinct from 'records' and p_format is distinct from 'audit' then
    raise exception 'format must be records or audit';
  end if;

  select c.* into v_camp
  from public.camps c
  where (p_camp_id is not null and c.id = p_camp_id)
     or (p_camp_id is null and c.is_active)
  order by c.is_active desc, c.id
  limit 1;

  if not found then
    raise exception 'no camp selected or active';
  end if;

  select t.template into v_template
  from public.prescription_template_versions t
  where t.camp_id = v_camp.id and t.status = 'published'
  order by t.version desc
  limit 1;

  if v_template is not null and jsonb_typeof(v_template->'diagnosisOptions') = 'array' then
    select coalesce(array_agg(btrim(opt#>>'{}') order by ord), array[]::text[])
      into v_options
    from jsonb_array_elements(v_template->'diagnosisOptions') with ordinality as e(opt, ord)
    where jsonb_typeof(opt) = 'string' and char_length(btrim(opt#>>'{}')) > 0;
  end if;

  if cardinality(v_options) = 0 and jsonb_typeof(v_camp.prescription_template->'diagnosisOptions') = 'array' then
    select coalesce(array_agg(btrim(opt#>>'{}') order by ord), array[]::text[])
      into v_options
    from jsonb_array_elements(v_camp.prescription_template->'diagnosisOptions')
      with ordinality as e(opt, ord)
    where jsonb_typeof(opt) = 'string' and char_length(btrim(opt#>>'{}')) > 0;
  end if;

  if p_format = 'records' then
    select coalesce(jsonb_agg(row_json order by reg_no), '[]'::jsonb)
    into v_rows
    from (
      select
        p.reg_no,
        jsonb_build_object(
          'reg_no', p.reg_no,
          'patient_name', p.full_name,
          'age', p.age,
          'gender', p.gender,
          'phone', p.phone,
          'address', p.address,
          'camp_name', v_camp.name,
          'transcription_at', t.created_at,
          'data', case
            when t.id is null then null
            else coalesce((
              select corr.replacement_data
              from public.prescription_corrections corr
              where corr.transcription_id = t.id
                and corr.correction_kind = 'clinical'
              order by corr.created_at desc
              limit 1
            ), t.data)
          end,
          'medicine_outcome', med.outcome,
          'specs_outcome', specs.outcome,
          'ot_outcome', ot.outcome,
          'unavailable_medicines', med.unavailable_medicines
        ) as row_json
      from public.patients p
      left join public.prescription_transcriptions t
        on t.patient_id = p.id
        and (p_include_archived or t.archived_at is null)
      left join public.fulfilment_items med
        on med.transcription_id = t.id and med.kind = 'medicine'
      left join public.fulfilment_items specs
        on specs.transcription_id = t.id and specs.kind = 'specs'
      left join public.fulfilment_items ot
        on ot.transcription_id = t.id and ot.kind = 'ot'
      where p.camp_id = v_camp.id
        and p.queue_status = 'seen'
        and (
          t.id is not null
          or not exists (
            select 1 from public.prescription_transcriptions t2
            where t2.patient_id = p.id
              and (p_include_archived or t2.archived_at is null)
          )
        )
      order by p.reg_no
    ) export_rows;

    return jsonb_build_object(
      'camp_id', v_camp.id,
      'camp_name', v_camp.name,
      'diagnosis_options', to_jsonb(v_options),
      'rows', v_rows
    );
  end if;

  -- audit format
  select coalesce(jsonb_agg(evt order by created_at, reg_no), '[]'::jsonb)
  into v_rows
  from (
    select
      p.reg_no,
      corr.created_at,
      jsonb_build_object(
        'reg_no', p.reg_no,
        'entity', 'prescription_correction',
        'event', corr.correction_kind,
        'from_outcome', null,
        'to_outcome', null,
        'reason', corr.reason,
        'actor_name', pr.full_name,
        'created_at', corr.created_at
      ) as evt
    from public.prescription_corrections corr
    join public.prescription_transcriptions t on t.id = corr.transcription_id
    join public.patients p on p.id = t.patient_id
    join public.profiles pr on pr.id = corr.created_by
    where p.camp_id = v_camp.id
      and (p_include_archived or t.archived_at is null)

    union all

    select
      p.reg_no,
      e.created_at,
      jsonb_build_object(
        'reg_no', p.reg_no,
        'entity', 'fulfilment_' || i.kind,
        'event', e.event,
        'from_outcome', e.from_outcome,
        'to_outcome', e.to_outcome,
        'reason', e.reason,
        'actor_name', pr.full_name,
        'created_at', e.created_at
      ) as evt
    from public.fulfilment_events e
    join public.fulfilment_items i on i.id = e.item_id
    join public.prescription_transcriptions t on t.id = i.transcription_id
    join public.patients p on p.id = t.patient_id
    join public.profiles pr on pr.id = e.created_by
    where p.camp_id = v_camp.id
      and (p_include_archived or t.archived_at is null)

    union all

    select
      p.reg_no,
      s.issued_at as created_at,
      jsonb_build_object(
        'reg_no', p.reg_no,
        'entity', 'deferred_slip',
        'event', s.status,
        'from_outcome', null,
        'to_outcome', s.service,
        'reason', s.reference || ' v' || s.version::text,
        'actor_name', pr.full_name,
        'created_at', s.issued_at
      ) as evt
    from public.deferred_slips s
    join public.fulfilment_items i on i.id = s.item_id
    join public.prescription_transcriptions t on t.id = i.transcription_id
    join public.patients p on p.id = t.patient_id
    join public.profiles pr on pr.id = s.issued_by
    where p.camp_id = v_camp.id
      and (p_include_archived or t.archived_at is null)
  ) events;

  return jsonb_build_object(
    'camp_id', v_camp.id,
    'camp_name', v_camp.name,
    'rows', v_rows
  );
end $$;

revoke all on function public.admin_clinical_export(uuid,text,boolean) from public, anon;
grant execute on function public.admin_clinical_export(uuid,text,boolean)
  to authenticated, service_role, postgres;

-- ---------------------------------------------------------------------------
-- Readiness catalog: migration head + new signature / column / function
-- ---------------------------------------------------------------------------
do $migration$
declare
  v_definition text;
begin
  select pg_get_functiondef('public.readiness_catalog_probe()'::regprocedure)
    into v_definition;

  v_definition := replace(
    v_definition,
    $$public.latest_applied_migration() = '20260805100000'$$,
    $$public.latest_applied_migration() = '20260809120000'$$
  );
  -- Exact quoted signatures only (substring replace on bare (uuid,text,text)
  -- would also match the new (uuid,text,text,text[]) form).
  v_definition := replace(
    v_definition,
    $$'public.clinical_resolve_item(uuid,text,text)'$$,
    $$'public.clinical_resolve_item(uuid,text,text,text[])'$$
  );
  v_definition := replace(
    v_definition,
    $$('clinical_resolve_item','public.clinical_resolve_item(uuid,text,text,text[])')$$,
    $$('clinical_resolve_item','public.clinical_resolve_item(uuid,text,text,text[])'),
    ('admin_clinical_export','public.admin_clinical_export(uuid,text,boolean)')$$
  );
  v_definition := replace(
    v_definition,
    $$('fulfilment_items','resolved_at')$$,
    $$('fulfilment_items','resolved_at'),
    ('fulfilment_items','unavailable_medicines')$$
  );

  if strpos(v_definition, '20260809120000') = 0 then
    raise exception 'failed to advance readiness migration head to 20260809120000';
  end if;

  -- Split grants jsonb_build_object: PG FUNC_MAX_ARGS is 100; the combined
  -- grants map exceeded that limit after Batch 2 and could not execute.
  -- Drop the trailing comma on the previous pair before closing the first half.
  if strpos(v_definition, ') || jsonb_build_object(') = 0 then
    v_definition := replace(
      v_definition,
      $$'latest_applied_migration_service_role_execute', has_function_privilege('service_role','public.latest_applied_migration()','EXECUTE'),
    'persons_authenticated_select', has_table_privilege$$,
      $$'latest_applied_migration_service_role_execute', has_function_privilege('service_role','public.latest_applied_migration()','EXECUTE')
  ) || jsonb_build_object(
    'persons_authenticated_select', has_table_privilege$$
    );
  end if;

  execute v_definition;
end $migration$;
