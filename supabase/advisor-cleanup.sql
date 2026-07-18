-- Make the intentional deny-all verification table policy explicit to the
-- database advisor. Service role bypasses RLS and remains the sole grantee.
drop policy if exists "deny client access" on public.registration_verifications;
create policy "deny client access" on public.registration_verifications
  for all to anon, authenticated
  using (false)
  with check (false);
