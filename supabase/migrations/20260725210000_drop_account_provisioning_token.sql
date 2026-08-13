-- #17 — Drop hand-rolled two-phase provisioning lock.
-- Concurrency is the conditional update on patients.user_id IS NULL.
-- Never edit the baseline dump; append-only migrations only.

DROP INDEX IF EXISTS public.patients_account_provisioning_token_idx;

ALTER TABLE public.patients
  DROP COLUMN IF EXISTS account_provisioning_token;

-- Keep readiness contract green until #22 retires app_database_contract.
-- Replace the lock-column probe with passcode_issued_at (added in #16).
CREATE OR REPLACE FUNCTION public.app_database_contract() RETURNS text
    LANGUAGE sql
    STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select case
    when to_regprocedure(
      'public.register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid)'
    ) is not null
      and to_regprocedure('public.doctor_recent_patients(uuid,integer)') is not null
      and to_regprocedure('public.link_patient_phone(text)') is not null
      and exists (
        select 1
        from pg_catalog.pg_attribute a
        join pg_catalog.pg_class c on c.oid = a.attrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname = 'patients'
          and a.attname = 'registration_request_id'
          and a.attnum > 0
          and not a.attisdropped
      )
      and exists (
        select 1
        from pg_catalog.pg_attribute a
        join pg_catalog.pg_class c on c.oid = a.attrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname = 'patients'
          and a.attname = 'passcode_issued_at'
          and a.attnum > 0
          and not a.attisdropped
      )
    then '20260722005000'
    else 'incomplete'
  end;
$$;

ALTER FUNCTION public.app_database_contract() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.app_database_contract() FROM PUBLIC;
GRANT ALL ON FUNCTION public.app_database_contract() TO service_role;
