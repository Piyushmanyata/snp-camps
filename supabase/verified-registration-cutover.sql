-- Safe pre-deploy setup for the server-owned verified-registration path.
-- Apply verified-registration-revoke-anon.sql after the new frontend deploy.

create table if not exists public.registration_verifications (
  token_hash text primary key
    check (token_hash ~ '^[0-9a-f]{64}$'),
  aadhaar_last4 char(4) not null
    check (aadhaar_last4 ~ '^[0-9]{4}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

alter table public.registration_verifications enable row level security;
revoke all on table public.registration_verifications
  from public, anon, authenticated;
grant select, insert, update, delete on table public.registration_verifications
  to service_role;
drop policy if exists "deny client access" on public.registration_verifications;
create policy "deny client access" on public.registration_verifications
  for all to anon, authenticated
  using (false)
  with check (false);

create index if not exists registration_verifications_expires_idx
  on public.registration_verifications (expires_at);

create or replace function public.register_verified_patient(
  p_verification_token text,
  p_camp_id uuid,
  p_full_name text,
  p_gender text default null,
  p_age integer default null,
  p_address text default null,
  p_phone text default null,
  p_email text default null,
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
set search_path = public, extensions
as $$
declare
  v_claim public.registration_verifications%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role only';
  end if;
  if p_verification_token !~ '^[0-9a-f]{64}$' then
    raise exception 'Registration verification is invalid';
  end if;

  select v.* into v_claim
  from public.registration_verifications v
  where v.token_hash = encode(extensions.digest(p_verification_token, 'sha256'), 'hex')
    and v.consumed_at is null
    and v.expires_at > now()
  for update;

  if v_claim.token_hash is null then
    raise exception 'Registration verification expired or was already used';
  end if;

  return query
  select r.*
  from public.register_patient(
    p_camp_id => p_camp_id,
    p_full_name => p_full_name,
    p_gender => p_gender,
    p_age => p_age,
    p_address => p_address,
    p_phone => p_phone,
    p_email => p_email,
    p_aadhaar_last4 => v_claim.aadhaar_last4,
    p_user_id => null,
    p_created_by => null,
    p_camp_day_id => p_camp_day_id
  ) r;

  update public.registration_verifications v
  set consumed_at = now()
  where v.token_hash = v_claim.token_hash;
end;
$$;

revoke all on function public.register_verified_patient(
  text, uuid, text, text, integer, text, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.register_verified_patient(
  text, uuid, text, text, integer, text, text, text, uuid
) to service_role;
