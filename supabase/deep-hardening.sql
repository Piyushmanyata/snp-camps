-- Deep hardening after the security/performance audit.
-- Apply after optimization-hardening.sql and the QR staff-scan functions.
-- This is idempotent and deliberately keeps service_role access unchanged.

begin;

-- Claim tokens are server-only secrets. The authenticated role needs patient
-- lookup/queue columns, but it must never be able to mint an account by
-- reading account_claim_token through PostgREST.
revoke all on table public.patients from authenticated;
grant select (
  id,
  user_id,
  camp_id,
  reg_no,
  full_name,
  gender,
  age,
  address,
  phone,
  email,
  aadhaar_last4,
  queue_status,
  seen_at,
  created_by,
  created_at,
  queued_at,
  camp_day_id,
  printed_at,
  seen_by,
  phone_normalized,
  full_name_normalized
) on table public.patients to authenticated;
grant delete on table public.patients to authenticated;

-- The unique partial index already covers active-camp lookups; remove the
-- redundant non-unique copy to reduce write work and catalog noise.
drop index if exists public.camps_is_active_idx;

commit;

notify pgrst, 'reload schema';
