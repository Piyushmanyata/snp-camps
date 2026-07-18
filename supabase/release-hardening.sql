-- Final release hardening. Safe to apply before the frontend deployment.
-- The anonymous grant remains temporarily for the old frontend and is removed
-- by verified-registration-revoke-anon.sql after the new API is live.

alter function public.register_patient(
  uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid
) rename to register_patient_authorized_impl;

revoke all on function public.register_patient_authorized_impl(
  uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid
) from public, anon, authenticated, service_role;

create function public.register_patient(
  p_camp_id uuid,
  p_full_name text,
  p_gender text default null,
  p_age integer default null,
  p_address text default null,
  p_phone text default null,
  p_email text default null,
  p_aadhaar_last4 text default null,
  p_user_id uuid default null,
  p_created_by uuid default null,
  p_camp_day_id uuid default null
)
returns table (
  id uuid,
  reg_no integer,
  full_name text,
  camp_day_id uuid,
  day_date date,
  claim_token text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_request_role text;
begin
  v_request_role := nullif(current_setting('request.jwt.claim.role', true), '');

  if v_request_role = 'authenticated' and not public.is_staff() then
    raise exception 'staff only';
  end if;
  if v_request_role not in ('anon', 'authenticated', 'service_role') then
    raise exception 'API role required';
  end if;

  return query
  select r.*
  from public.register_patient_authorized_impl(
    p_camp_id => p_camp_id,
    p_full_name => p_full_name,
    p_gender => p_gender,
    p_age => p_age,
    p_address => p_address,
    p_phone => p_phone,
    p_email => p_email,
    p_aadhaar_last4 => p_aadhaar_last4,
    p_user_id => p_user_id,
    p_created_by => p_created_by,
    p_camp_day_id => p_camp_day_id
  ) r;
end;
$$;

revoke all on function public.register_patient(
  uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.register_patient(
  uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid
) to anon, authenticated, service_role;

-- Contains-search on normalized patient names needs trigram indexing; a normal
-- B-tree cannot accelerate ILIKE '%term%'.
create extension if not exists pg_trgm with schema extensions;
create index if not exists patients_full_name_trgm_idx
  on public.patients using gin (
    full_name_normalized extensions.gin_trgm_ops
  );

-- Keep short-lived identity-verification claims bounded without relying on a
-- web request to perform maintenance.
create extension if not exists pg_cron with schema pg_catalog;
do $$
begin
  if not exists (
    select 1 from cron.job
    where jobname = 'cleanup-registration-verifications'
  ) then
    perform cron.schedule(
      'cleanup-registration-verifications',
      '17 * * * *',
      $job$
        delete from public.registration_verifications
        where expires_at < now() - interval '1 day'
           or consumed_at < now() - interval '1 day';
      $job$
    );
  end if;
end;
$$;
