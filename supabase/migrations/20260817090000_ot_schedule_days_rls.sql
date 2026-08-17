-- ot_schedule_days shipped in 20260816230000 without row level security.
--
-- Supabase's default privileges grant anon and authenticated full DML on new
-- public tables, so PostgREST exposed /rest/v1/ot_schedule_days for direct
-- SELECT/INSERT/UPDATE/DELETE. Any signed-in volunteer could PATCH seat_limit
-- to 0 or DELETE a scheduled OT day, walking straight around the is_admin()
-- gate and the SEAT_LIMIT_BELOW_ASSIGNED guard inside upsert_ot_schedule_day.
-- It is the only table in the schema without RLS.
--
-- Nothing reads or writes the table directly: reads go through
-- list_ot_schedule_days(uuid) and writes through upsert_ot_schedule_day(...),
-- both SECURITY DEFINER. So the table takes the same posture as
-- public_rate_limit_buckets (20260728101000) — RLS on, no grants, no policy.
-- The definer functions keep working because they run as the owner.

ALTER TABLE public.ot_schedule_days OWNER TO postgres;
ALTER TABLE public.ot_schedule_days ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ot_schedule_days
  FROM PUBLIC, anon, authenticated, service_role;

-- fulfilment_items.ot_schedule_day_id (20260816230000) carries a foreign key
-- but no index. upsert_ot_schedule_day counts deferred items against the seat
-- limit on every schedule edit, and the unindexed FK forces a sequential scan
-- of fulfilment_items on any ot_schedule_days delete.
CREATE INDEX IF NOT EXISTS fulfilment_items_ot_schedule_day_id_idx
  ON public.fulfilment_items (ot_schedule_day_id);

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
AS $$ SELECT '20260817090000'::text $$;

DO $$
BEGIN
  IF public.latest_applied_migration() <> '20260817090000' THEN
    RAISE EXCEPTION 'latest_applied_migration must report this migration as head, got %',
      public.latest_applied_migration();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'ot_schedule_days'
      AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'ot_schedule_days must have row level security enabled';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name = 'ot_schedule_days'
      AND grantee IN ('anon', 'authenticated')
  ) THEN
    RAISE EXCEPTION 'ot_schedule_days must hold no anon or authenticated grant';
  END IF;
END
$$;
