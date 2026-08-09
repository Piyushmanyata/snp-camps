-- Clinical export review fixes (follow-up to #128).
-- Append-only: redefines admin_clinical_export; does not edit 20260809120000.
-- - Drop inline prescription_template fallback for diagnosis columns
-- - Append retired diagnosis options actually stored on camp transcriptions
-- - Deferred slip audit grain: one "issued" event per slip + slip_reference
-- - Advance readiness catalog head with guarded replacement

create or replace function public.admin_clinical_export(
  p_camp_id uuid default null,
  p_format text default 'records',
  p_include_archived boolean default false
) returns jsonb language plpgsql stable security definer
set search_path to pg_catalog, public as $$
declare
  v_camp public.camps%rowtype;
  v_options text[] := array[]::text[];
  v_retired text[] := array[]::text[];
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

  -- Published template only — no inline prescription_template fallback.
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

  -- Retired: options actually stored on effective {options,other} records in this camp,
  -- not present in the published template. Legacy array-shaped diagnoses are not scanned.
  select coalesce(array_agg(opt order by opt), array[]::text[])
    into v_retired
  from (
    select distinct btrim(opt#>>'{}') as opt
    from public.prescription_transcriptions t
    join public.patients p on p.id = t.patient_id
    cross join lateral (
      select case
        when t.id is null then null
        else coalesce((
          select corr.replacement_data
          from public.prescription_corrections corr
          where corr.transcription_id = t.id
            and corr.correction_kind = 'clinical'
          order by corr.created_at desc
          limit 1
        ), t.data)
      end as data
    ) effective
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(effective.data->'diagnoses'->'options') = 'array'
        then effective.data->'diagnoses'->'options'
        else '[]'::jsonb
      end
    ) as e(opt)
    where p.camp_id = v_camp.id
      and (p_include_archived or t.archived_at is null)
      and jsonb_typeof(opt) = 'string'
      and char_length(btrim(opt#>>'{}')) > 0
      and not (btrim(opt#>>'{}') = any (v_options))
  ) retired_opts;

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
      'diagnosis_options', to_jsonb(v_options || v_retired),
      'retired_diagnosis_options', to_jsonb(v_retired),
      'rows', v_rows
    );
  end if;

  -- audit format: one row per event. Slip arm is issue-only; replacement reason
  -- lives on prescription_corrections; later fulfilment/reversal on fulfilment_events.
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
        'slip_reference', null,
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
        'slip_reference', null,
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
        'event', 'issued',
        'from_outcome', null,
        'to_outcome', s.service,
        'slip_reference', s.reference || ' v' || s.version::text,
        'reason', null,
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

-- Readiness catalog head: guarded advance only (other entries already present).
do $migration$
declare
  v_definition text;
  v_old text := $$public.latest_applied_migration() = '20260809120000'$$;
  v_new text := $$public.latest_applied_migration() = '20260809140000'$$;
begin
  select pg_get_functiondef('public.readiness_catalog_probe()'::regprocedure)
    into v_definition;

  if strpos(v_definition, v_old) = 0 then
    if strpos(v_definition, '20260809140000') > 0 then
      raise notice 'readiness migration head already at 20260809140000';
      return;
    end if;
    raise exception 'readiness migration head anchor not found (expected 20260809120000)';
  end if;

  v_definition := replace(v_definition, v_old, v_new);

  if strpos(v_definition, '20260809140000') = 0 then
    raise exception 'failed to advance readiness migration head to 20260809140000';
  end if;

  execute v_definition;
end $migration$;
