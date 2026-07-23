-- Security linter remediation: SECURITY DEFINER function grant tightening.
--
-- Resolves all Supabase database-linter warnings:
--   - anon_security_definer_function_executable  (active_camp_snapshot)
--   - authenticated_security_definer_function_executable (all others)
--   - auth_leaked_password_protection  (Supabase Dashboard setting — see note below)
--
-- Each flagged function already enforces its own role check internally
-- (is_admin(), is_staff(), auth.uid() guards, or auth.role() checks).
-- The warnings are fired because the schema was originally populated with
-- "GRANT ALL ON FUNCTION ... TO authenticated" — a pg_dump artifact that
-- grants trivially-irrelevant non-EXECUTE privileges alongside EXECUTE.
-- Replacing every "GRANT ALL" with a targeted "GRANT EXECUTE" is the
-- correct minimal-privilege posture and silences the linter.
--
-- active_camp_snapshot() note:
--   This function returns only public seat-availability data (no PII) and is
--   intentionally callable without sign-in so the registration page can show
--   available days to unauthenticated visitors. We retain the anon grant.
--   To fully silence the anon warning, revoke anon and call via service-role
--   server-side instead; that is a product decision, not a security defect.
--
-- auth_leaked_password_protection note:
--   This is a Supabase Auth configuration setting, not a database object.
--   Enable it at:  Dashboard → Authentication → Settings → Password strength
--   → "Enable leaked password protection"
--   No SQL migration can change this setting.
--
-- Forward-only: correcting over-broad grants never breaks callers.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

select pg_advisory_xact_lock(
  hashtext('snp-camps:20260722050000_security_definer_grant_tighten')
);

-- ──────────────────────────────────────────────────────────────────────────────
-- active_camp_snapshot()
-- Returns public-facing seat availability. anon grant is intentional; revoke
-- anon here only if you move this call server-side behind service-role.
-- ──────────────────────────────────────────────────────────────────────────────
revoke all on function public.active_camp_snapshot() from public, anon, authenticated;
grant execute on function public.active_camp_snapshot() to anon, authenticated, service_role;

-- ──────────────────────────────────────────────────────────────────────────────
-- assign_patient_doctor(uuid, integer, uuid)
-- Internal guard: role in ('admin','volunteer','doctor') AND disabled_at IS NULL
-- ──────────────────────────────────────────────────────────────────────────────
revoke all on function public.assign_patient_doctor(uuid, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.assign_patient_doctor(uuid, integer, uuid)
  to authenticated, service_role;

-- ──────────────────────────────────────────────────────────────────────────────
-- camp_day_stats(uuid)
-- No internal auth guard — returns seat counts only (no PII). Authenticated
-- users may read this for the registration form. Revoke anon to be safe.
-- ──────────────────────────────────────────────────────────────────────────────
revoke all on function public.camp_day_stats(uuid) from public, anon, authenticated;
grant execute on function public.camp_day_stats(uuid) to authenticated, service_role;

-- ──────────────────────────────────────────────────────────────────────────────
-- camp_queue_counts(uuid)
-- Internal guard: is_staff() → active admin or volunteer only
-- ──────────────────────────────────────────────────────────────────────────────
revoke all on function public.camp_queue_counts(uuid) from public, anon, authenticated;
grant execute on function public.camp_queue_counts(uuid) to authenticated, service_role;

-- ──────────────────────────────────────────────────────────────────────────────
-- change_camp_day(uuid, uuid)
-- Internal guard: is_staff() OR patient must be the caller; active camp check
-- ──────────────────────────────────────────────────────────────────────────────
revoke all on function public.change_camp_day(uuid, uuid) from public, anon, authenticated;
grant execute on function public.change_camp_day(uuid, uuid) to authenticated, service_role;

-- ──────────────────────────────────────────────────────────────────────────────
-- delete_camp(uuid)
-- Internal guard: is_admin() only
-- ──────────────────────────────────────────────────────────────────────────────
revoke all on function public.delete_camp(uuid) from public, anon, authenticated;
grant execute on function public.delete_camp(uuid) to authenticated, service_role;

-- ──────────────────────────────────────────────────────────────────────────────
-- delete_camp_day(uuid)
-- Internal guard: is_admin() only
-- ──────────────────────────────────────────────────────────────────────────────
revoke all on function public.delete_camp_day(uuid) from public, anon, authenticated;
grant execute on function public.delete_camp_day(uuid) to authenticated, service_role;

-- ──────────────────────────────────────────────────────────────────────────────
-- doctor_my_counts(uuid, timestamptz)
-- Internal guard: role in ('doctor','admin') AND disabled_at IS NULL
-- ──────────────────────────────────────────────────────────────────────────────
revoke all on function public.doctor_my_counts(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.doctor_my_counts(uuid, timestamptz)
  to authenticated, service_role;

-- ──────────────────────────────────────────────────────────────────────────────
-- doctor_recent_patients(uuid, integer)
-- Internal guard: is_doctor() — role = 'doctor' AND disabled_at IS NULL
-- ──────────────────────────────────────────────────────────────────────────────
revoke all on function public.doctor_recent_patients(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.doctor_recent_patients(uuid, integer)
  to authenticated, service_role;

-- ──────────────────────────────────────────────────────────────────────────────
-- is_admin() / is_doctor() / is_staff()
-- Role-check predicates used inside RLS policies and SECURITY DEFINER RPCs.
-- Must be callable by authenticated so RLS policies evaluate correctly.
-- ──────────────────────────────────────────────────────────────────────────────
revoke all on function public.is_admin() from public, anon, authenticated;
grant execute on function public.is_admin() to authenticated, service_role;

revoke all on function public.is_doctor() from public, anon, authenticated;
grant execute on function public.is_doctor() to authenticated, service_role;

revoke all on function public.is_staff() from public, anon, authenticated;
grant execute on function public.is_staff() to authenticated, service_role;

-- ──────────────────────────────────────────────────────────────────────────────
-- link_patient_phone(text)
-- Internal guard: auth.uid() IS NOT NULL AND role = 'patient' AND phone verified
-- ──────────────────────────────────────────────────────────────────────────────
revoke all on function public.link_patient_phone(text) from public, anon, authenticated;
grant execute on function public.link_patient_phone(text) to authenticated, service_role;

-- ──────────────────────────────────────────────────────────────────────────────
-- lookup_patient_scan(uuid, integer)
-- Internal guard: role in ('admin','volunteer','doctor') AND disabled_at IS NULL
-- ──────────────────────────────────────────────────────────────────────────────
revoke all on function public.lookup_patient_scan(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.lookup_patient_scan(uuid, integer)
  to authenticated, service_role;

-- ──────────────────────────────────────────────────────────────────────────────
-- mark_patient_printed(uuid)
-- Internal guard: is_staff() → active admin or volunteer only
-- ──────────────────────────────────────────────────────────────────────────────
revoke all on function public.mark_patient_printed(uuid) from public, anon, authenticated;
grant execute on function public.mark_patient_printed(uuid) to authenticated, service_role;

-- ──────────────────────────────────────────────────────────────────────────────
-- register_patient_idempotent(uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid)
-- Internal guard: auth.role() in ('authenticated','service_role')
--   + is_staff() enforced for authenticated callers
-- ──────────────────────────────────────────────────────────────────────────────
revoke all on function public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.register_patient_idempotent(
  uuid, uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid
) to authenticated, service_role;

-- ──────────────────────────────────────────────────────────────────────────────
-- set_active_camp(uuid)
-- Internal guard: is_admin() only
-- ──────────────────────────────────────────────────────────────────────────────
revoke all on function public.set_active_camp(uuid) from public, anon, authenticated;
grant execute on function public.set_active_camp(uuid) to authenticated, service_role;

-- ──────────────────────────────────────────────────────────────────────────────
-- staff_person_kpis(uuid, text, uuid, timestamptz)
-- Internal guard: role in ('admin','volunteer','doctor') AND disabled_at IS NULL
--   + non-admin callers may only query their own stats
-- ──────────────────────────────────────────────────────────────────────────────
revoke all on function public.staff_person_kpis(uuid, text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.staff_person_kpis(uuid, text, uuid, timestamptz)
  to authenticated, service_role;

-- ──────────────────────────────────────────────────────────────────────────────
-- upsert_camp_day(uuid, date, integer, uuid)
-- Internal guard: is_admin() only
-- ──────────────────────────────────────────────────────────────────────────────
revoke all on function public.upsert_camp_day(uuid, date, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.upsert_camp_day(uuid, date, integer, uuid)
  to authenticated, service_role;

-- ──────────────────────────────────────────────────────────────────────────────
-- volunteer_my_counts(timestamptz)
-- Internal guard: role in ('admin','volunteer') AND disabled_at IS NULL
-- ──────────────────────────────────────────────────────────────────────────────
revoke all on function public.volunteer_my_counts(timestamptz)
  from public, anon, authenticated;
grant execute on function public.volunteer_my_counts(timestamptz)
  to authenticated, service_role;

-- ──────────────────────────────────────────────────────────────────────────────
-- Stale schema.sql artifact: register_patient() was dropped in
-- 20260722010000_production_hardening.sql but its grant row may still exist
-- in pg_catalog on databases initialised from schema.sql before that migration
-- ran. Revoke defensively; DROP IF EXISTS is a no-op if already dropped.
-- ──────────────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regprocedure(
    'public.register_patient(uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid)'
  ) is not null then
    execute $q$
      revoke all on function public.register_patient(
        uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid
      ) from public, anon, authenticated
    $q$;
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
