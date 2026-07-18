-- Hotfix: "function gen_random_bytes(integer) does not exist"
-- Cause: claim-token generation calls pgcrypto, but the security-definer
-- function only had search_path = public. On Supabase, pgcrypto lives in
-- the extensions schema.
--
-- Safe to re-run. Apply in Supabase SQL Editor.

create extension if not exists pgcrypto with schema extensions;

do $$
declare
  v_impl regprocedure := to_regprocedure(
    'public.register_patient_authorized_impl(uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid)'
  );
  v_public regprocedure := to_regprocedure(
    'public.register_patient(uuid, text, text, integer, text, text, text, text, uuid, uuid, uuid)'
  );
begin
  -- Preferred: post release-hardening rename (impl holds the claim-token logic).
  if v_impl is not null then
    execute format(
      'alter function %s set search_path = public, extensions',
      v_impl
    );
  elsif v_public is not null then
    -- Pre release-hardening: register_patient itself holds the body.
    execute format(
      'alter function %s set search_path = public, extensions',
      v_public
    );
  else
    raise exception
      'register_patient / register_patient_authorized_impl not found';
  end if;
end;
$$;

-- Smoke check (must return true).
select extensions.gen_random_bytes(24) is not null as pgcrypto_ok;
