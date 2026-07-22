-- Expand-only release step. Apply before deploying code that reads disabled_at.
-- This migration is backward-compatible with the currently deployed app.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

select pg_advisory_xact_lock(
  hashtext('snp-camps:20260722000000_disabled_staff_expand')
);

alter table public.profiles
  add column if not exists disabled_at timestamptz;

comment on column public.profiles.disabled_at is
  'Server-managed staff deactivation timestamp; null means active.';

-- Close the token-revocation gap during the deploy interval while preserving
-- the old application's role capabilities. The enforce step later narrows
-- is_staff() so doctors receive only their dedicated scan RPCs.
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.role in ('admin', 'volunteer', 'doctor')
      and p.disabled_at is null
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'admin'
      and p.disabled_at is null
  );
$$;

create or replace function public.is_doctor()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'doctor'
      and p.disabled_at is null
  );
$$;

-- Deactivation is server-managed. This is compatible with the old app, which
-- has no client-side profile UPDATE call, and prevents an unexpired JWT from
-- clearing disabled_at before the enforce step.
drop policy if exists "authenticated update permitted profiles" on public.profiles;
drop policy if exists "update own profile or admin" on public.profiles;
revoke all privileges on table public.profiles from anon, authenticated;
grant select on table public.profiles to authenticated;

notify pgrst, 'reload schema';

commit;
