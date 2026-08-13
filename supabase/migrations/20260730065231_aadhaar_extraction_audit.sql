-- Successful Aadhaar extraction audit. The browser requires explicit consent
-- before decoding; the trusted database boundary timestamps accepted scanned
-- registrations without receiving or retaining the raw QR payload.

create table public.aadhaar_extraction_events (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null unique
    references public.patients(id) on delete cascade,
  consent_at timestamptz not null default now(),
  method text not null default 'SECURE_QR'
    check (method = 'SECURE_QR'),
  trust_level text not null default 'SELF_DECLARED'
    check (trust_level = 'SELF_DECLARED'),
  outcome text not null default 'PARSED'
    check (outcome = 'PARSED'),
  aadhaar_last4 character(4) not null
    check (aadhaar_last4 ~ '^[0-9]{4}$'),
  created_at timestamptz not null default now()
);

comment on table public.aadhaar_extraction_events is
  'Consent and provenance audit for successfully parsed Aadhaar QR data. '
  'No raw artifact, full Aadhaar number, or identity-verification claim.';

alter table public.aadhaar_extraction_events enable row level security;
revoke all on public.aadhaar_extraction_events
  from public, anon, authenticated;
grant all on public.aadhaar_extraction_events
  to service_role, postgres;
create policy aadhaar_extraction_events_deny_browser
  on public.aadhaar_extraction_events
  for all to anon, authenticated
  using (false)
  with check (false);

create or replace function public.audit_scanned_aadhaar_registration()
returns trigger language plpgsql security definer
set search_path to pg_catalog, public as $$
begin
  if new.provenance = 'card_scanned' and new.aadhaar_last4 ~ '^[0-9]{4}$' then
    insert into public.aadhaar_extraction_events(
      patient_id, aadhaar_last4
    ) values (
      new.id, new.aadhaar_last4
    ) on conflict (patient_id) do nothing;
  end if;
  return new;
end $$;
revoke all on function public.audit_scanned_aadhaar_registration()
  from public, anon, authenticated;
grant execute on function public.audit_scanned_aadhaar_registration()
  to service_role, postgres;

create trigger audit_scanned_aadhaar_registration
after insert on public.patients
for each row execute function public.audit_scanned_aadhaar_registration();

do $migration$
declare v_definition text; v_old text; v_new text;
begin
  select pg_get_functiondef('public.readiness_catalog_probe()'::regprocedure)
    into v_definition;
  v_old := $old$public.latest_applied_migration() = '20260730040210'$old$;
  v_new := $new$public.latest_applied_migration() = '20260730065231'$new$;
  if strpos(v_definition,v_old)=0 then
    raise exception 'readiness migration head anchor not found';
  end if;
  execute replace(v_definition,v_old,v_new);
end $migration$;
