-- The baseline schema revoked SELECT/INSERT/UPDATE/DELETE selectively on the
-- four tables it created, so camps, camp_days, patients and profiles still
-- carried the Supabase default-privilege grants of TRUNCATE, TRIGGER and
-- REFERENCES to anon and authenticated. Every table added afterwards took the
-- REVOKE ALL treatment (sms_deliveries 20260726190000, persons 20260727210000,
-- public_rate_limit_buckets 20260728101000, ot_schedule_days 20260817090000),
-- which is why these four are the only rows left in role_table_grants.
--
-- This is hygiene, not an open hole: nothing today can reach either grant.
-- PostgREST exposes no TRUNCATE verb and no DDL, plain TRUNCATE on all four
-- tables stops at "cannot truncate a table referenced in a foreign key
-- constraint", TRUNCATE ... CASCADE stops at permission denied on a dependent
-- table that did revoke correctly, and no trigger-returning function is
-- executable by anon or authenticated. But every one of those is an accident of
-- the current FK graph and of other tables' grants, not a guard on these four.
--
-- Row level security never filters TRUNCATE, so the grant genuinely sits
-- outside every policy here -- unlike the DELETE grant on patients, which the
-- admin-only policy does gate. TRIGGER likewise lets a grantee attach a trigger
-- that then runs inside later writes, including those made by the SECURITY
-- DEFINER desk RPCs. Nothing uses them, so they go.
--
-- The DML grants stay exactly as they are; RLS gates those and the app depends
-- on them (anon reads the active camp, authenticated reads camps and camp_days,
-- admin-only policies cover the writes).

REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLE
  public.camps,
  public.camp_days,
  public.patients,
  public.profiles
  FROM PUBLIC, anon, authenticated;

-- Every migration that becomes the head redefines this literal; readiness
-- compares it against EXPECTED_MIGRATION_HEAD and the probe's
-- migration_head_current fact is derived from it. Same signature and return
-- type, so CREATE OR REPLACE keeps the existing grants.
CREATE OR REPLACE FUNCTION public.latest_applied_migration()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$ SELECT '20260824090000'::text $$;

DO $$
DECLARE
  residual text;
BEGIN
  IF public.latest_applied_migration() <> '20260824090000' THEN
    RAISE EXCEPTION 'latest_applied_migration must report this migration as head, got %',
      public.latest_applied_migration();
  END IF;

  SELECT string_agg(format('%s:%s:%s', table_name, grantee, privilege_type), ', ')
    INTO residual
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND grantee IN ('anon', 'authenticated')
    AND privilege_type IN ('TRUNCATE', 'TRIGGER', 'REFERENCES');

  IF residual IS NOT NULL THEN
    RAISE EXCEPTION 'residual TRUNCATE/TRIGGER/REFERENCES grants remain: %', residual;
  END IF;

  -- The reads the app still depends on must survive the revoke.
  IF NOT has_table_privilege('anon', 'public.camps', 'SELECT') THEN
    RAISE EXCEPTION 'anon lost SELECT on camps';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.camp_days', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated lost SELECT on camp_days';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.profiles', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated lost SELECT on profiles';
  END IF;
END
$$;
