-- #22 / D11 — Retire hand-maintained app_database_contract version string.
--
-- Replace with a thin ledger reader: latest applied version from
-- supabase_migrations.schema_migrations (no hardcoded timestamp).

DROP FUNCTION IF EXISTS public.app_database_contract();

CREATE OR REPLACE FUNCTION public.latest_applied_migration()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
  select version
  from supabase_migrations.schema_migrations
  order by version desc
  limit 1;
$$;

ALTER FUNCTION public.latest_applied_migration() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.latest_applied_migration() FROM PUBLIC;
GRANT ALL ON FUNCTION public.latest_applied_migration() TO service_role;
