# #56 Evidence — Retire patient Realtime and restore least-privilege desk reads

Date: 2026-07-26  
Base commit: `d4a982756950cd8302a97fbbaab7912418eabd2d`  
Worktree: local uncommitted implementation (not yet committed)

## Defect (red) — reproduced before fix

Audit (and this ticket) reproduced under `SET LOCAL ROLE authenticated` with doctor JWT claims:

- SELECT of name, address, phone, email, aadhaar_last4 succeeded for an unrelated active-camp patient
- SELECT of `status_token` (32 hex) succeeded
- Transaction rolled back

Root cause: migration `20260725234000_patients_realtime_desk.sql` widened patient SELECT to `is_camp_crew()` (includes doctors) for Realtime, and `20260726090000` granted `status_token` to `authenticated`.

## Fix summary

### Database (`20260726150000_retire_patient_realtime_least_privilege.sql`)

1. Drop `patients` from `supabase_realtime` publication; reset replica identity DEFAULT
2. Restore SELECT policy to admin + active-camp `is_staff()` (not doctors)
3. `REVOKE SELECT (status_token) FROM authenticated`
4. Add `patient_registration_notify_fields(uuid)` SECURITY DEFINER for staff-only SMS token access

### Application

1. Deleted Realtime modules: `camp-desk-realtime.ts`, `use-camp-desk-realtime.ts`, reconnecting indicator
2. Added shared camp-keyed poll owner (`camp-desk-live.ts` + `use-camp-desk-live.ts`)
3. LiveQueue + SeatBoard share one owner (no stacked polls; generation-safe apply)
4. Desk API role-projects waiting rows (doctors never receive phone)
5. Registration notify uses notify RPC instead of table SELECT of status_token
6. Doctor bridge continuous ~20s `router.refresh` poll only

## Verification

| Gate | Result | Notes |
|---|---|---|
| Role DB tests `patient-read-boundary.db.test.mjs` | 7/7 pass | doctor/admin/volunteer/disabled/inactive/publication/RPC |
| `npm run test:db` | 27/27 pass | includes new boundary suite |
| `npm run verify` | pass | lint, **190** unit tests, production build, JS budgets |
| `npm run test:e2e` | **14/14 pass** | after cleanup of boundary-test camp pollution |
| Clean migration replay | pass | `supabase db reset --yes` applied all migrations including #56 |
| 100-waiting payload | 12314 bytes | under 40KB budget (`DESK_LIVE_PAYLOAD_100_BYTES`) |

### Role transcript (post-fix, synthetic — values redacted)

- Doctor SELECT PHI columns → **0 rows**
- Doctor/volunteer/admin SELECT `status_token` → **permission denied**
- Volunteer SELECT active-camp desk fields → **1 row** (name/phone present)
- Disabled volunteer / inactive camp → **0 rows**
- `patient_registration_notify_fields` staff → returns token; doctor → **staff only**
- `pg_publication_tables` patients in supabase_realtime → **0**

### Coverage delta

- Removed: Realtime subscription unit + wiring tests that asserted continuous poll was retired
- Added: role boundary DB tests; poll-owner behaviour tests (out-of-order, shared owner, pending removals, stale-error); poll-only wiring proofs
- Unit test count: 187 → 190

## Rollback

1. Do **not** re-grant `status_token` to authenticated or re-widen policy to `is_camp_crew()`
2. Code rollback may restore temporary Realtime client code only if a later ticket re-decides product direction (currently forbidden by #55)
3. Migration is append-only; reverse via a new migration that keeps restrictive grants

## Remaining risk

- Production deploy of migration requires human authorization (#34)
- #72 owns permanent replacement of residual wiring-style assertions across the suite
- Doctor desk waiting list (if used) relies on service-role projection path in `/api/desk/live` after crew auth — staff path still uses session RLS
- Boundary DB tests must clean `venue='boundary-test'` fixtures (done in `test.after`) so they do not deactivate e2e active camps

## Blockers for closing #56 on GitHub

- Commit + PR not created (awaiting user)
- Production migration not applied (requires #34 authority)
- #74 Stage 1 evidence validator not yet frozen; this file is temporary compatible evidence
