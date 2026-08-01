-- Issue #126: clinical desk history, correction, fulfilment, and record paging fixes.

create index if not exists prescription_corrections_transcription_idx
  on public.prescription_corrections (transcription_id, created_at desc);
create index if not exists deferred_slips_replaced_by_idx
  on public.deferred_slips (replaced_by);
create index if not exists sponsor_assets_camp_idx
  on public.sponsor_assets (camp_id);

create or replace function public.clinical_lookup(
  p_patient_id uuid default null, p_reg_no integer default null
) returns jsonb language plpgsql stable security definer
set search_path to pg_catalog, public as $$
declare
  r public.patients%rowtype;
  v_result jsonb;
  v_history jsonb;
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

  select coalesce(jsonb_agg(jsonb_build_object(
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
    ),'[]'::jsonb)
  ) order by ht.created_at desc), '[]'::jsonb)
    into v_history
  from public.prescription_transcriptions ht
  join public.patients hp on hp.id = ht.patient_id
  join public.camps hc on hc.id=hp.camp_id
  where hp.person_id = r.person_id and hp.id <> r.id;

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
    'history', v_history
  ) into v_result
  from (select * from public.prescription_transcriptions
        where patient_id = r.id) t;
  return coalesce(v_result, jsonb_build_object(
    'patient', jsonb_build_object('id', r.id, 'reg_no', r.reg_no,
      'full_name', r.full_name, 'age', r.age, 'gender', r.gender,
      'person_id', r.person_id, 'camp_id', r.camp_id),
    'transcription', null, 'effective_data', null, 'corrections', '[]'::jsonb,
    'items', '[]'::jsonb, 'history', v_history));
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
  if v_previous is null or v_previous not in ('deferred','not_available') then
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
  if not (public.is_staff() or public.is_clinical_operator()) then
    raise exception 'camp crew or clinical desk only';
  end if;
  select template into v_template from public.prescription_template_versions
    where camp_id=p_camp_id and status='published';
  return v_template;
end $$;

drop function public.admin_clinical_records(boolean);

create or replace function public.admin_clinical_records(
  p_camp_id uuid default null,
  p_include_archived boolean default false,
  p_limit integer default 50,
  p_offset integer default 0
) returns jsonb language plpgsql stable security definer
set search_path to pg_catalog, public as $$
declare
  v_result jsonb;
  v_total bigint;
  v_camp_id uuid;
  v_limit integer := least(greatest(coalesce(p_limit,50),1),200);
  v_offset integer := greatest(coalesce(p_offset,0),0);
begin
  if not public.is_admin() then raise exception 'admin only'; end if;

  select c.id into v_camp_id
  from public.camps c
  where (p_camp_id is not null and c.id=p_camp_id)
     or (p_camp_id is null and c.is_active)
  order by c.is_active desc, c.id
  limit 1;

  select count(*) into v_total
  from public.prescription_transcriptions t
  join public.patients p on p.id=t.patient_id
  where p.camp_id=v_camp_id
    and (p_include_archived or t.archived_at is null);

  select coalesce(jsonb_agg(jsonb_build_object(
    'transcription_id',page.id,'patient_id',page.patient_id,'reg_no',page.reg_no,
    'patient_name',page.full_name,'camp_name',page.camp_name,
    'data',coalesce((
      select corr.replacement_data from public.prescription_corrections corr
      where corr.transcription_id=page.id and corr.correction_kind='clinical'
      order by corr.created_at desc limit 1
    ),page.transcription_data),
    'created_at',page.created_at,'locked_at',page.locked_at,'archived_at',page.archived_at,
    'corrections',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',corr.id,'kind',corr.correction_kind,'reason',corr.reason,
        'replacement_data',corr.replacement_data,'created_by',corr.created_by,
        'created_at',corr.created_at
      ) order by corr.created_at)
      from public.prescription_corrections corr where corr.transcription_id=page.id
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
      from public.fulfilment_items i where i.transcription_id=page.id
    ),'[]'::jsonb)
  ) order by page.created_at desc, page.id desc),'[]'::jsonb) into v_result
  from (
    select t.id,t.patient_id,p.reg_no,p.full_name,c.name as camp_name,
      t.data as transcription_data,t.created_at,t.locked_at,t.archived_at
    from public.prescription_transcriptions t
    join public.patients p on p.id=t.patient_id
    join public.camps c on c.id=p.camp_id
    where p.camp_id=v_camp_id
      and (p_include_archived or t.archived_at is null)
    order by t.created_at desc, t.id desc
    limit v_limit offset v_offset
  ) page;

  return jsonb_build_object('records',v_result,'total',v_total);
end $$;

revoke all on function public.clinical_lookup(uuid,integer) from public, anon;
grant execute on function public.clinical_lookup(uuid,integer)
  to authenticated, service_role, postgres;
revoke all on function public.admin_reverse_fulfilment(uuid,text) from public, anon;
grant execute on function public.admin_reverse_fulfilment(uuid,text)
  to authenticated, service_role, postgres;
revoke all on function public.published_prescription_template(uuid) from public, anon;
grant execute on function public.published_prescription_template(uuid)
  to authenticated, service_role, postgres;
revoke all on function public.admin_clinical_records(uuid,boolean,integer,integer) from public, anon;
grant execute on function public.admin_clinical_records(uuid,boolean,integer,integer)
  to authenticated, service_role, postgres;

do $migration$
declare v_definition text; v_old text; v_new text;
begin
  select pg_get_functiondef('public.readiness_catalog_probe()'::regprocedure)
    into v_definition;
  v_old := $old$public.latest_applied_migration() = '20260731100000'$old$;
  v_new := $new$public.latest_applied_migration() = '20260801071600'$new$;
  if strpos(v_definition,v_old)=0 then
    if strpos(v_definition,v_new)>0 then
      raise notice 'readiness migration head already at 20260801071600';
      return;
    end if;
    raise exception 'readiness migration head anchor not found';
  end if;
  execute replace(v_definition,v_old,v_new);
end $migration$;
