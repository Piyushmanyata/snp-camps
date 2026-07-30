-- Issue #124: scan-first registration, outcome-qualified credit, Clinical Desk,
-- deferred-care slips, follow-up, and versioned A4 templates.

alter table public.patients
  add column if not exists manual_exception_actor uuid references public.profiles(id),
  add column if not exists manual_exception_at timestamptz,
  add column if not exists manual_exception_reason text,
  add column if not exists failed_scan_attempts integer;

alter table public.patients drop constraint if exists patients_provenance_check;
alter table public.patients add constraint patients_provenance_check
  check (provenance in ('self_declared', 'card_scanned', 'manual_exception'));
alter table public.patients add constraint patients_manual_exception_check check (
  (provenance <> 'manual_exception' and manual_exception_actor is null
    and manual_exception_at is null and manual_exception_reason is null
    and failed_scan_attempts is null)
  or
  (provenance = 'manual_exception' and manual_exception_actor is not null
    and manual_exception_at is not null
    and nullif(btrim(manual_exception_reason), '') is not null
    and failed_scan_attempts >= 3)
);

create or replace function public.is_clinical_operator()
returns boolean language sql stable security definer
set search_path to pg_catalog, public as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid())
      and role = 'clinical_operator'
      and disabled_at is null
  );
$$;
revoke all on function public.is_clinical_operator() from public, anon;
grant execute on function public.is_clinical_operator()
  to authenticated, service_role, postgres;

create table public.prescription_transcriptions (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null unique references public.patients(id),
  data jsonb not null default '{}'::jsonb,
  paper_source boolean not null default true check (paper_source),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_by uuid not null references public.profiles(id),
  updated_at timestamptz not null default now(),
  locked_at timestamptz,
  archived_at timestamptz,
  check (jsonb_typeof(data) = 'object'),
  check (octet_length(data::text) <= 32768)
);

create table public.prescription_corrections (
  id uuid primary key default gen_random_uuid(),
  transcription_id uuid not null references public.prescription_transcriptions(id),
  reason text not null check (char_length(btrim(reason)) between 3 and 500),
  correction_kind text not null default 'clinical'
    check (correction_kind in ('clinical','slip','fulfilment')),
  replacement_data jsonb not null check (jsonb_typeof(replacement_data) = 'object'),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.fulfilment_items (
  id uuid primary key default gen_random_uuid(),
  transcription_id uuid not null references public.prescription_transcriptions(id),
  kind text not null check (kind in ('medicine', 'specs', 'ot')),
  outcome text not null,
  current_version integer not null default 1 check (current_version > 0),
  resolved_by uuid not null references public.profiles(id),
  resolved_at timestamptz not null default now(),
  unique (transcription_id, kind),
  check (
    (kind = 'medicine' and outcome in ('fulfilled', 'not_available', 'not_required'))
    or (kind in ('specs', 'ot') and outcome in ('fulfilled', 'deferred', 'not_required'))
  )
);

create table public.fulfilment_events (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.fulfilment_items(id),
  event text not null check (event in ('resolved', 'fulfilled_later', 'reversed')),
  from_outcome text,
  to_outcome text not null,
  reason text,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.deferred_slips (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.fulfilment_items(id),
  reference text not null,
  version integer not null check (version > 0),
  service text not null check (service in ('specs', 'ot')),
  date_snapshot date not null,
  venue_snapshot text not null check (char_length(btrim(venue_snapshot)) between 1 and 300),
  issued_by uuid not null references public.profiles(id),
  issued_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active', 'cancelled', 'fulfilled')),
  replaced_by uuid references public.deferred_slips(id),
  unique (reference, version)
);
create unique index deferred_slips_one_active
  on public.deferred_slips(item_id) where status = 'active';

create table public.prescription_template_versions (
  id uuid primary key default gen_random_uuid(),
  camp_id uuid not null references public.camps(id),
  version integer not null,
  status text not null check (status in ('draft', 'published', 'superseded')),
  template jsonb not null check (jsonb_typeof(template) = 'object'),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (camp_id, version)
);
create unique index prescription_template_one_published
  on public.prescription_template_versions(camp_id) where status = 'published';
create unique index prescription_template_one_draft
  on public.prescription_template_versions(camp_id) where status = 'draft';

create table public.sponsor_assets (
  id uuid primary key default gen_random_uuid(),
  camp_id uuid not null references public.camps(id),
  object_key text not null unique,
  mime_type text not null check (mime_type in ('image/png', 'image/jpeg', 'image/webp')),
  byte_size integer not null check (byte_size between 1 and 2097152),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('prescription-sponsors','prescription-sponsors',false,2097152,
  array['image/png','image/jpeg','image/webp'])
on conflict (id) do update set public=false,file_size_limit=2097152,
  allowed_mime_types=excluded.allowed_mime_types;

create index transcription_patient_idx on public.prescription_transcriptions(patient_id);
create index fulfilment_unresolved_idx on public.fulfilment_items(outcome, transcription_id);
create index fulfilment_events_item_idx on public.fulfilment_events(item_id, created_at);

alter table public.prescription_transcriptions enable row level security;
alter table public.prescription_corrections enable row level security;
alter table public.fulfilment_items enable row level security;
alter table public.fulfilment_events enable row level security;
alter table public.deferred_slips enable row level security;
alter table public.prescription_template_versions enable row level security;
alter table public.sponsor_assets enable row level security;

revoke all on public.prescription_transcriptions, public.prescription_corrections,
  public.fulfilment_items, public.fulfilment_events, public.deferred_slips,
  public.prescription_template_versions, public.sponsor_assets
  from public, anon, authenticated;
grant all on public.prescription_transcriptions, public.prescription_corrections,
  public.fulfilment_items, public.fulfilment_events, public.deferred_slips,
  public.prescription_template_versions, public.sponsor_assets
  to service_role, postgres;

create or replace function public.register_manual_exception(
  p_request_id uuid, p_camp_id uuid, p_camp_day_id uuid, p_full_name text,
  p_display_name text, p_gender text, p_age integer, p_address text,
  p_phone text, p_reason text, p_failed_scan_attempts integer, p_actor_id uuid
) returns setof public.patients
language plpgsql security definer set search_path to pg_catalog, public as $$
declare v_role public.user_role; v_patient_id uuid;
begin
  select role into v_role from public.profiles
  where id = p_actor_id and disabled_at is null;
  if v_role not in ('admin', 'team_lead') then
    raise exception 'manual exception requires Team Lead or admin';
  end if;
  if p_failed_scan_attempts < 3 or nullif(btrim(p_reason), '') is null
     or p_phone !~ '^[6-9][0-9]{9}$' or p_phone ~ '^([0-9])\1{9}$' then
    raise exception 'invalid manual exception evidence';
  end if;
  select id into v_patient_id from public.register_patient_idempotent(
    p_request_id, p_camp_id, p_full_name, p_gender, p_age, p_address, p_phone,
    null, null, null, p_actor_id, p_camp_day_id, false, false, false,
    'self_declared', null, null, p_display_name
  );
  update public.patients set
    provenance = 'manual_exception',
    manual_exception_actor = p_actor_id,
    manual_exception_at = now(),
    manual_exception_reason = left(btrim(p_reason), 500),
    failed_scan_attempts = p_failed_scan_attempts
  where id = v_patient_id;
  return query select * from public.patients where id = v_patient_id;
end $$;
revoke all on function public.register_manual_exception(
  uuid,uuid,uuid,text,text,text,integer,text,text,text,integer,uuid
) from public, anon, authenticated;
grant execute on function public.register_manual_exception(
  uuid,uuid,uuid,text,text,text,integer,text,text,text,integer,uuid
) to service_role, postgres;

-- Household phones are deliberately shareable. Remove them from both the
-- likely-duplicate predicate and its serialization key while retaining the
-- existing name+age warning.
do $migration$
declare v_signature regprocedure := to_regprocedure(
  'public.register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean,boolean,text,text,date,text)'
); v_definition text; v_old text; v_new text;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  v_old := $old$    IF v_phone10 IS NOT NULL THEN
      v_soft_lock_keys := array_append(
        v_soft_lock_keys,
        'phone:' || p_camp_id::text || ':' || v_phone10
      );
    END IF;
$old$;
  if strpos(v_definition,v_old)=0 then raise exception 'phone duplicate lock anchor missing'; end if;
  v_definition:=replace(v_definition,v_old,'');
  v_old := $old$      AND (
        (
          p_age IS NOT NULL
          AND p.age IS NOT NULL
          AND p.full_name_normalized = v_name_norm
          AND p.age = p_age
        )
        OR (
          v_phone10 IS NOT NULL
          AND p.phone_normalized IS NOT NULL
          AND p.phone_normalized = v_phone10
        )
      )$old$;
  v_new := $new$      AND p_age IS NOT NULL
      AND p.age IS NOT NULL
      AND p.full_name_normalized = v_name_norm
      AND p.age = p_age$new$;
  if strpos(v_definition,v_old)=0 then raise exception 'phone duplicate predicate anchor missing'; end if;
  execute replace(v_definition,v_old,v_new);
end $migration$;

create or replace function public.clinical_lookup(
  p_patient_id uuid default null, p_reg_no integer default null
) returns jsonb language plpgsql security definer
set search_path to pg_catalog, public as $$
declare r public.patients%rowtype; v_result jsonb;
begin
  if not (public.is_clinical_operator() or public.is_admin()) then
    raise exception 'clinical desk only';
  end if;
  if (p_patient_id is null) = (p_reg_no is null) then
    raise exception 'provide exactly one exact identifier';
  end if;
  select p.* into r from public.patients p
  join public.camps c on c.id=p.camp_id and c.is_active
  where (p_patient_id is not null and p.id = p_patient_id)
     or (p_reg_no is not null and p.reg_no = p_reg_no);
  if not found then raise exception 'registration not found'; end if;
  if r.queue_status <> 'seen' then raise exception 'patient has not been seen'; end if;
  select jsonb_build_object(
    'patient', jsonb_build_object('id', r.id, 'reg_no', r.reg_no,
      'full_name', r.full_name, 'age', r.age, 'gender', r.gender,
      'person_id', r.person_id, 'camp_id', r.camp_id),
    'transcription', to_jsonb(t),
    'effective_data', coalesce((
      select c.replacement_data from public.prescription_corrections c
      where c.transcription_id=t.id and c.correction_kind='clinical'
      order by c.created_at desc limit 1
    ),t.data),
    'corrections', coalesce((
      select jsonb_agg(jsonb_build_object(
        'reason',c.reason,'replacement_data',c.replacement_data,
        'created_at',c.created_at,'created_by',c.created_by
      ) order by c.created_at)
      from public.prescription_corrections c where c.transcription_id=t.id
    ),'[]'::jsonb),
    'items', coalesce((select jsonb_agg(
      to_jsonb(i) || jsonb_build_object('slip',(
        select jsonb_build_object(
          'id',s.id,'date',s.date_snapshot,'venue',s.venue_snapshot
        ) from public.deferred_slips s
        where s.item_id=i.id and s.status='active'
      )) order by i.kind)
      from public.fulfilment_items i where i.transcription_id = t.id), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object(
      'camp_id', hp.camp_id, 'camp_name', hc.name,
      'created_at', ht.created_at, 'data', coalesce((
        select hcorr.replacement_data
        from public.prescription_corrections hcorr
        where hcorr.transcription_id=ht.id and hcorr.correction_kind='clinical'
        order by hcorr.created_at desc limit 1
      ),ht.data),
      'items',coalesce((
        select jsonb_agg(jsonb_build_object(
          'kind',hi.kind,'outcome',hi.outcome,'resolved_at',hi.resolved_at
        ) order by hi.kind)
        from public.fulfilment_items hi where hi.transcription_id=ht.id
      ),'[]'::jsonb)))
      from public.prescription_transcriptions ht
      join public.patients hp on hp.id = ht.patient_id
      join public.camps hc on hc.id=hp.camp_id
      where hp.person_id = r.person_id and hp.id <> r.id), '[]'::jsonb)
  ) into v_result
  from (select * from public.prescription_transcriptions
        where patient_id = r.id) t;
  return coalesce(v_result, jsonb_build_object(
    'patient', jsonb_build_object('id', r.id, 'reg_no', r.reg_no,
      'full_name', r.full_name, 'age', r.age, 'gender', r.gender,
      'person_id', r.person_id, 'camp_id', r.camp_id),
    'transcription', null, 'effective_data', null, 'corrections', '[]'::jsonb,
    'items', '[]'::jsonb, 'history', '[]'::jsonb));
end $$;

create or replace function public.assert_valid_clinical_data(p_data jsonb)
returns void language plpgsql immutable
set search_path to pg_catalog, public as $$
declare v_value text; v_eye jsonb; v_key text;
begin
  if jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>32768
     or jsonb_typeof(p_data->'diagnoses') is distinct from 'array'
     or jsonb_array_length(p_data->'diagnoses') not between 1 and 12
     or exists (
       select 1 from jsonb_array_elements(p_data->'diagnoses') diagnosis
       where jsonb_typeof(diagnosis)<>'string'
          or char_length(btrim(diagnosis#>>'{}')) not between 1 and 120
     ) then raise exception 'valid diagnosis options are required'; end if;
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

create or replace function public.clinical_save_transcription(
  p_patient_id uuid, p_data jsonb
) returns public.prescription_transcriptions
language plpgsql security definer set search_path to pg_catalog, public as $$
declare v_actor uuid := (select auth.uid()); v_row public.prescription_transcriptions;
begin
  if not public.is_clinical_operator() then raise exception 'clinical operator only'; end if;
  perform public.assert_valid_clinical_data(p_data);
  if not exists (
    select 1 from public.patients p join public.camps c on c.id=p.camp_id
    where p.id=p_patient_id and p.queue_status='seen' and c.is_active
  )
     then raise exception 'patient has not been seen'; end if;
  insert into public.prescription_transcriptions(patient_id,data,created_by,updated_by)
    values (p_patient_id,p_data,v_actor,v_actor)
  on conflict (patient_id) do update set data = excluded.data,
    updated_by = v_actor, updated_at = now()
    where public.prescription_transcriptions.locked_at is null
  returning * into v_row;
  if v_row.id is null then raise exception 'transcription is locked; add a correction'; end if;
  return v_row;
end $$;

create or replace function public.clinical_add_correction(
  p_patient_id uuid, p_data jsonb, p_reason text
) returns public.prescription_corrections
language plpgsql security definer set search_path to pg_catalog, public as $$
declare v_actor uuid := (select auth.uid()); v_t uuid; v_row public.prescription_corrections;
begin
  if not (public.is_clinical_operator() or public.is_admin()) then raise exception 'clinical desk only'; end if;
  if nullif(btrim(p_reason),'') is null then raise exception 'correction reason required'; end if;
  perform public.assert_valid_clinical_data(p_data);
  select t.id into v_t from public.prescription_transcriptions t
    join public.patients p on p.id=t.patient_id
    join public.camps c on c.id=p.camp_id
    where t.patient_id=p_patient_id and t.locked_at is not null
      and p.queue_status='seen' and c.is_active;
  if v_t is null then raise exception 'locked transcription not found'; end if;
  insert into public.prescription_corrections(transcription_id,reason,replacement_data,created_by)
    values(v_t,p_reason,p_data,v_actor) returning * into v_row;
  return v_row;
end $$;

create or replace function public.clinical_resolve_item(
  p_patient_id uuid, p_kind text, p_outcome text
) returns jsonb language plpgsql security definer
set search_path to pg_catalog, public as $$
declare v_actor uuid := (select auth.uid()); v_t public.prescription_transcriptions;
  v_item public.fulfilment_items; v_camp public.camps%rowtype;
  v_date date; v_venue text; v_slip public.deferred_slips; v_data jsonb;
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
  insert into public.fulfilment_items(transcription_id,kind,outcome,resolved_by)
    values(v_t.id,p_kind,p_outcome,v_actor)
  on conflict (transcription_id,kind) do nothing returning * into v_item;
  if v_item.id is null then
    select * into v_item from public.fulfilment_items
      where transcription_id=v_t.id and kind=p_kind;
    if v_item.outcome <> p_outcome then raise exception 'outcome conflict'; end if;
  else
    update public.prescription_transcriptions set locked_at=coalesce(locked_at,now())
      where id=v_t.id;
    insert into public.fulfilment_events(item_id,event,to_outcome,created_by)
      values(v_item.id,'resolved',p_outcome,v_actor);
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

create or replace function public.clinical_followup_fulfil(p_item_id uuid)
returns public.fulfilment_items language plpgsql security definer
set search_path to pg_catalog, public as $$
declare v_actor uuid := (select auth.uid()); v_item public.fulfilment_items; v_old text;
begin
  if not public.is_clinical_operator() then raise exception 'clinical operator only'; end if;
  select i.* into v_item from public.fulfilment_items i
    join public.prescription_transcriptions t on t.id=i.transcription_id
    join public.patients p on p.id=t.patient_id
    join public.camps c on c.id=p.camp_id
    where i.id=p_item_id and not c.is_active for update of i;
  if not found or v_item.outcome not in ('deferred','not_available')
    then raise exception 'item is not unresolved historical care'; end if;
  v_old:=v_item.outcome;
  update public.fulfilment_items set outcome='fulfilled', resolved_by=v_actor,
    resolved_at=now(), current_version=current_version+1 where id=p_item_id returning * into v_item;
  update public.deferred_slips set status='fulfilled' where item_id=p_item_id and status='active';
  insert into public.fulfilment_events(item_id,event,from_outcome,to_outcome,created_by)
    values(p_item_id,'fulfilled_later',v_old,'fulfilled',v_actor);
  return v_item;
end $$;

create or replace function public.clinical_followup_lookup(
  p_patient_id uuid default null, p_reg_no integer default null
) returns jsonb language plpgsql stable security definer
set search_path to pg_catalog, public as $$
declare v_person uuid; v_result jsonb;
begin
  if not (public.is_clinical_operator() or public.is_admin()) then raise exception 'clinical desk only'; end if;
  if (p_patient_id is null)=(p_reg_no is null) then raise exception 'provide exactly one identifier'; end if;
  select person_id into v_person from public.patients
    where (p_patient_id is not null and id=p_patient_id)
       or (p_reg_no is not null and reg_no=p_reg_no);
  if v_person is null then raise exception 'registration not found'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',i.id,'kind',i.kind,'outcome',i.outcome,'reg_no',p.reg_no,
    'patient_name',p.full_name,'camp_name',c.name,'resolved_at',i.resolved_at
  ) order by i.resolved_at),'[]'::jsonb) into v_result
  from public.fulfilment_items i
  join public.prescription_transcriptions t on t.id=i.transcription_id
  join public.patients p on p.id=t.patient_id
  join public.camps c on c.id=p.camp_id
  where p.person_id=v_person and not c.is_active
    and i.outcome in ('deferred','not_available');
  return v_result;
end $$;

create or replace function public.clinical_slip_by_id(p_slip_id uuid)
returns jsonb language plpgsql security definer
set search_path to pg_catalog, public as $$
declare v_result jsonb;
begin
  if not (public.is_clinical_operator() or public.is_admin()) then raise exception 'clinical desk only'; end if;
  select jsonb_build_object(
    'id',s.id,'reference',s.reference,'version',s.version,'service',s.service,
    'date',s.date_snapshot,'venue',s.venue_snapshot,'issued_at',s.issued_at,
    'patient_id',p.id,'reg_no',p.reg_no,'name',p.full_name,'age',p.age,
    'gender',p.gender,'camp_name',c.name
  ) into v_result
  from public.deferred_slips s
  join public.fulfilment_items i on i.id=s.item_id
  join public.prescription_transcriptions t on t.id=i.transcription_id
  join public.patients p on p.id=t.patient_id
  join public.camps c on c.id=p.camp_id
  where s.id=p_slip_id and s.status='active';
  if v_result is null then raise exception 'active slip not found'; end if;
  return v_result;
end $$;

create or replace function public.clinical_replace_slip(
  p_slip_id uuid, p_date date, p_venue text, p_reason text
) returns public.deferred_slips language plpgsql security definer
set search_path to pg_catalog, public as $$
declare v_actor uuid := (select auth.uid()); v_old public.deferred_slips; v_new public.deferred_slips;
begin
  if not (public.is_clinical_operator() or public.is_admin()) then raise exception 'clinical desk only'; end if;
  if nullif(btrim(p_reason),'') is null or p_date is null or nullif(btrim(p_venue),'') is null
     then raise exception 'replacement reason, date, and venue required'; end if;
  select * into v_old from public.deferred_slips where id=p_slip_id and status='active' for update;
  if not found then raise exception 'active slip not found'; end if;
  update public.deferred_slips set status='cancelled' where id=v_old.id;
  insert into public.deferred_slips(item_id,reference,version,service,date_snapshot,
    venue_snapshot,issued_by)
    values(v_old.item_id,v_old.reference,v_old.version+1,v_old.service,p_date,p_venue,v_actor)
    returning * into v_new;
  update public.deferred_slips set replaced_by=v_new.id where id=v_old.id;
  insert into public.prescription_corrections(
    transcription_id,reason,replacement_data,created_by,correction_kind
  )
    select i.transcription_id,p_reason,jsonb_build_object('slip_replaced',v_old.id,'replacement',v_new.id),v_actor,'slip'
    from public.fulfilment_items i where i.id=v_old.item_id;
  return v_new;
end $$;

create or replace function public.admin_prescription_template_editor(p_camp_id uuid)
returns jsonb language plpgsql stable security definer
set search_path to pg_catalog, public as $$
declare v_template jsonb;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  select template into v_template from public.prescription_template_versions
    where camp_id=p_camp_id and status in ('draft','published')
    order by case status when 'draft' then 0 else 1 end,version desc limit 1;
  return v_template;
end $$;

create or replace function public.admin_save_prescription_template(
  p_camp_id uuid, p_template jsonb, p_publish boolean default false
) returns public.prescription_template_versions
language plpgsql security definer set search_path to pg_catalog, public as $$
declare v_actor uuid := (select auth.uid()); v_version integer;
  v_row public.prescription_template_versions; v_section_count integer;
  v_section_height numeric; v_logo_count integer; v_template jsonb;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  if jsonb_typeof(p_template)<>'object' or octet_length(p_template::text)>65536
     or jsonb_typeof(p_template->'sections')<>'array'
     or jsonb_typeof(p_template->'sponsorLogos')<>'array'
     then raise exception 'valid template schema required'; end if;
  select count(*),coalesce(sum((s->>'heightMm')::numeric)
    filter(where coalesce((s->>'visible')::boolean,true)),0)
    into v_section_count,v_section_height
    from jsonb_array_elements(p_template->'sections') s
    where jsonb_typeof(s)='object'
      and s->>'key' in ('remarks','medicines')
      and char_length(btrim(s->>'label')) between 1 and 80
      and jsonb_typeof(s->'heightMm')='number'
      and (s->>'heightMm')::numeric in (10,16,20,26,32)
      and (s->'visible' is null or jsonb_typeof(s->'visible')='boolean');
  if v_section_count<>jsonb_array_length(p_template->'sections')
     or v_section_count not between 1 and 4 or v_section_height>42
     or (select count(distinct s->>'key') from jsonb_array_elements(p_template->'sections') s)<>v_section_count
     then raise exception 'invalid or oversized template sections'; end if;
  select count(*) into v_logo_count from jsonb_array_elements_text(p_template->'sponsorLogos') logo
    where logo='/brand/rupa-logo.png'
       or logo ~ '^/api/admin/sponsor-assets/[0-9a-fA-F-]{36}$';
  if v_logo_count<>jsonb_array_length(p_template->'sponsorLogos')
     or v_logo_count>8 then raise exception 'invalid sponsor assets'; end if;
  v_template:=jsonb_set(p_template,'{fitsOnePage}','true'::jsonb,true);
  delete from public.prescription_template_versions where camp_id=p_camp_id and status='draft';
  select coalesce(max(version),0)+1 into v_version from public.prescription_template_versions where camp_id=p_camp_id;
  if p_publish then update public.prescription_template_versions set status='superseded'
    where camp_id=p_camp_id and status='published'; end if;
  insert into public.prescription_template_versions(camp_id,version,status,template,created_by,published_at)
    values(p_camp_id,v_version,case when p_publish then 'published' else 'draft' end,
      v_template,v_actor,case when p_publish then now() else null end)
    returning * into v_row;
  return v_row;
end $$;

create or replace function public.admin_clinical_records(p_include_archived boolean default false)
returns jsonb language plpgsql stable security definer
set search_path to pg_catalog, public as $$
declare v_result jsonb;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'transcription_id',t.id,'patient_id',p.id,'reg_no',p.reg_no,
    'patient_name',p.full_name,'camp_name',c.name,
    'data',coalesce((
      select corr.replacement_data from public.prescription_corrections corr
      where corr.transcription_id=t.id and corr.correction_kind='clinical'
      order by corr.created_at desc limit 1
    ),t.data),
    'created_at',t.created_at,'locked_at',t.locked_at,'archived_at',t.archived_at,
    'corrections',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',corr.id,'kind',corr.correction_kind,'reason',corr.reason,
        'replacement_data',corr.replacement_data,'created_by',corr.created_by,
        'created_at',corr.created_at
      ) order by corr.created_at)
      from public.prescription_corrections corr where corr.transcription_id=t.id
    ),'[]'::jsonb),
    'items',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',i.id,'kind',i.kind,'outcome',i.outcome,
        'resolved_by',i.resolved_by,'resolved_at',i.resolved_at,
        'events',coalesce((
          select jsonb_agg(jsonb_build_object(
            'id',e.id,'event',e.event,'from_outcome',e.from_outcome,
            'to_outcome',e.to_outcome,'reason',e.reason,
            'created_by',e.created_by,'created_at',e.created_at
          ) order by e.created_at)
          from public.fulfilment_events e where e.item_id=i.id
        ),'[]'::jsonb),
        'slips',coalesce((
          select jsonb_agg(jsonb_build_object(
            'id',s.id,'reference',s.reference,'version',s.version,
            'service',s.service,'date',s.date_snapshot,'venue',s.venue_snapshot,
            'status',s.status,'replaced_by',s.replaced_by,
            'issued_by',s.issued_by,'issued_at',s.issued_at
          ) order by s.version)
          from public.deferred_slips s where s.item_id=i.id
        ),'[]'::jsonb)
      ) order by i.kind)
      from public.fulfilment_items i where i.transcription_id=t.id
    ),'[]'::jsonb)
  ) order by t.created_at desc),'[]'::jsonb) into v_result
  from public.prescription_transcriptions t
  join public.patients p on p.id=t.patient_id
  join public.camps c on c.id=p.camp_id
  where p_include_archived or t.archived_at is null;
  return v_result;
end $$;

create or replace function public.admin_archive_transcription(
  p_transcription_id uuid, p_archived boolean default true
) returns public.prescription_transcriptions
language plpgsql security definer set search_path to pg_catalog, public as $$
declare v_row public.prescription_transcriptions;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  update public.prescription_transcriptions
    set archived_at=case when p_archived then now() else null end
    where id=p_transcription_id returning * into v_row;
  if not found then raise exception 'transcription not found'; end if;
  return v_row;
end $$;

create or replace function public.admin_reverse_fulfilment(
  p_item_id uuid, p_reason text
) returns public.fulfilment_items
language plpgsql security definer set search_path to pg_catalog, public as $$
declare v_actor uuid := (select auth.uid()); v_item public.fulfilment_items;
  v_previous text; v_transcription uuid;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  if nullif(btrim(p_reason),'') is null then raise exception 'reversal reason required'; end if;
  select i.* into v_item
    from public.fulfilment_items i where i.id=p_item_id for update;
  if not found or v_item.outcome<>'fulfilled' then raise exception 'fulfilled item not found'; end if;
  v_transcription:=v_item.transcription_id;
  select e.from_outcome into v_previous from public.fulfilment_events e
    where e.item_id=p_item_id and e.event='fulfilled_later'
    order by e.created_at desc limit 1;
  if v_previous not in ('deferred','not_available') then
    raise exception 'only later fulfilment can be reversed';
  end if;
  update public.fulfilment_items set outcome=v_previous,resolved_by=v_actor,
    resolved_at=now(),current_version=current_version+1
    where id=p_item_id returning * into v_item;
  if v_previous='deferred' then
    update public.deferred_slips set status='active'
      where item_id=p_item_id and status='fulfilled' and replaced_by is null;
  end if;
  insert into public.fulfilment_events(item_id,event,from_outcome,to_outcome,created_by)
    values(p_item_id,'reversed','fulfilled',v_previous,v_actor);
  insert into public.prescription_corrections(
    transcription_id,reason,replacement_data,created_by,correction_kind
  )
    values(v_transcription,p_reason,jsonb_build_object(
      'fulfilment_reversed',p_item_id,'to_outcome',v_previous
    ),v_actor,'fulfilment');
  return v_item;
end $$;

create or replace function public.published_prescription_template(p_camp_id uuid)
returns jsonb language plpgsql stable security definer
set search_path to pg_catalog, public as $$
declare v_template jsonb;
begin
  if not public.is_staff() then raise exception 'registration staff only'; end if;
  select template into v_template from public.prescription_template_versions
    where camp_id=p_camp_id and status='published';
  return v_template;
end $$;

do $grants$
declare r record;
begin
  for r in select p.oid::regprocedure signature from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in (
      'clinical_lookup','clinical_save_transcription','clinical_add_correction',
      'clinical_resolve_item','clinical_followup_fulfil','clinical_followup_lookup','clinical_slip_by_id',
      'clinical_replace_slip',
      'admin_save_prescription_template','published_prescription_template',
      'admin_prescription_template_editor','admin_clinical_records',
      'admin_archive_transcription','admin_reverse_fulfilment'
    )
  loop
    execute format('revoke all on function %s from public, anon',r.signature);
    execute format('grant execute on function %s to authenticated, service_role, postgres',r.signature);
  end loop;
end $grants$;

-- A registration can score once, for its immutable original registrar, and
-- audited manual exceptions never score. Keep the existing RPC shape so every
-- desk uses the same canonical definition.
create or replace function public.staff_person_kpis(
  p_user_id uuid, p_role text, p_camp_id uuid default null,
  p_since timestamptz default null, p_scope text default 'person'
) returns table(
  total bigint,today bigint,waiting bigint,seen bigint,label text,
  staff_id uuid,full_name text,staff_role public.user_role,
  distinct_patients integer,team_lead_id uuid,team_headcount integer
) language plpgsql stable security definer
set search_path to pg_catalog, public as $$
declare v_caller uuid := (select auth.uid()); v_caller_role public.user_role;
  v_camp uuid; v_live boolean := false;
begin
  select role into v_caller_role from public.profiles
    where id=v_caller and disabled_at is null and role in ('admin','team_lead','volunteer');
  if v_caller_role is null then raise exception 'active camp crew required'; end if;
  select id into v_camp from public.camps where id=p_camp_id and is_active;
  if v_camp is not null then
    select (timezone('Asia/Kolkata',now()))::date >= min(day_date)
      into v_live from public.camp_days where camp_id=v_camp;
    v_live:=coalesce(v_live,false);
  end if;
  if p_scope='leaderboard' then
    if p_user_id is not null or p_role is not null then raise exception 'leaderboard target forbidden'; end if;
    return query
    with roster as (
      select p.id,p.full_name,p.role,p.team_lead_id
      from public.profiles p where p.disabled_at is null and p.role in ('team_lead','volunteer')
    ), scores as (
      select r.*,
        case when v_camp is null then 0 else (
          select count(*)::integer from public.patients x
          where x.camp_id=v_camp and x.created_by is not null
            and x.provenance<>'manual_exception'
            and (x.created_by=r.id or (r.role='team_lead' and x.created_by in
              (select m.id from roster m where m.team_lead_id=r.id and m.role='volunteer')))
        ) end registered_count,
        case when v_camp is null then 0 else (
          select count(*)::integer from public.patients x
          where x.camp_id=v_camp and x.created_by is not null
            and x.provenance<>'manual_exception' and x.queue_status='seen'
            and (x.created_by=r.id or (r.role='team_lead' and x.created_by in
              (select m.id from roster m where m.team_lead_id=r.id and m.role='volunteer')))
        ) end seen_count,
        case when r.role='team_lead' then
          (select count(*)::integer from roster m where m.team_lead_id=r.id and m.role='volunteer')
          else 0 end headcount
      from roster r
    )
    select s.registered_count::bigint,0::bigint,0::bigint,s.seen_count::bigint,
      case when v_live then 'Seen from registrations' else 'Registered' end,
      s.id,s.full_name,s.role,
      case when v_live then s.seen_count else s.registered_count end,
      s.team_lead_id,s.headcount
    from scores s
    order by (case when v_live then s.seen_count else s.registered_count end) desc,
      s.registered_count desc,s.full_name nulls last,s.id;
    return;
  end if;
  if p_scope<>'person' or p_user_id is null or p_role is null then raise exception 'invalid KPI target'; end if;
  if v_caller_role<>'admin' and v_caller<>p_user_id and not (
    v_caller_role='team_lead' and exists(select 1 from public.profiles profile
      where profile.id=p_user_id and profile.team_lead_id=v_caller
        and profile.role='volunteer')
  ) then raise exception 'forbidden'; end if;
  return query
  with members as (
    select p_user_id id union all
    select profile.id from public.profiles profile
      where p_role='team_lead' and profile.team_lead_id=p_user_id
      and profile.role='volunteer' and profile.disabled_at is null
  ), counts as (
    select count(*)::bigint registered,
      count(*) filter(where x.queue_status='seen')::bigint seen_count
    from public.patients x where x.camp_id=v_camp and x.provenance<>'manual_exception'
      and x.created_by in(select id from members)
  )
  select registered,0::bigint,0::bigint,seen_count,
    case when v_live then 'Seen from your registrations' else 'Registered' end,
    null::uuid,null::text,null::public.user_role,null::integer,null::uuid,null::integer
  from counts;
end $$;
revoke all on function public.staff_person_kpis(uuid,text,uuid,timestamptz,text)
  from public,anon;
grant execute on function public.staff_person_kpis(uuid,text,uuid,timestamptz,text)
  to authenticated,service_role,postgres;

create or replace function public.undo_mark_seen(p_patient_id uuid)
returns table(id uuid,reg_no integer,full_name text,queue_status public.queue_status,error_code text)
language plpgsql security definer set search_path to pg_catalog,public as $$
declare r public.patients%rowtype; v_active boolean;
begin
  if not public.is_staff() then raise exception 'staff only'; end if;
  select * into r from public.patients where public.patients.id=p_patient_id for update;
  if not found then raise exception 'Patient not found'; end if;
  select is_active into v_active from public.camps where public.camps.id=r.camp_id for update;
  if v_active is distinct from true then return query select r.id,r.reg_no,r.full_name,r.queue_status,'inactive_camp'::text; return; end if;
  if r.queue_status is distinct from 'seen' then return query select r.id,r.reg_no,r.full_name,r.queue_status,'not_seen'::text; return; end if;
  if exists(select 1 from public.prescription_transcriptions where patient_id=r.id) then
    return query select r.id,r.reg_no,r.full_name,r.queue_status,'clinical_started'::text; return;
  end if;
  if r.seen_at is null or r.seen_at<now()-interval '10 minutes' then
    return query select r.id,r.reg_no,r.full_name,r.queue_status,'undo_window_expired'::text; return;
  end if;
  update public.patients set queue_status='waiting',seen_at=null,seen_by=null
    where public.patients.id=r.id returning * into r;
  return query select r.id,r.reg_no,r.full_name,r.queue_status,null::text;
end $$;

do $migration$
declare v_definition text; v_old text; v_new text;
begin
  select pg_get_functiondef('public.readiness_catalog_probe()'::regprocedure)
    into v_definition;
  v_old := $old$public.latest_applied_migration() = '20260729104500'$old$;
  v_new := $new$public.latest_applied_migration() = '20260730040210'$new$;
  if strpos(v_definition,v_old)=0 then raise exception 'readiness migration head anchor not found'; end if;
  execute replace(v_definition,v_old,v_new);
end $migration$;
