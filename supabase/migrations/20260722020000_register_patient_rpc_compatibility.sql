-- Restore public.register_patient RPC compatibility wrapper for legacy and client callers,
-- delegating to public.register_patient_idempotent.

begin;

select pg_advisory_xact_lock(hashtext('snp_camps_migration_lock'));

create or replace function public.register_patient(
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
begin
  return query
  select
    r.id,
    r.reg_no,
    r.full_name,
    r.camp_day_id,
    r.day_date,
    null::text as claim_token
  from public.register_patient_idempotent(
    p_request_id => gen_random_uuid(),
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
) from public;

grant execute on function public.register_patient(
  uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid
) to authenticated, service_role, postgres;

notify pgrst, 'reload schema';

commit;
