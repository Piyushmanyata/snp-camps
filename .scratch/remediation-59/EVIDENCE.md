# #59 Evidence — Complete patient-Auth retirement

Date: 2026-07-26  
Branch: `fix/gate-a-56-57-58` (stacked after Gate A)  
Base: includes #56–#58 + #59 migration `20260726170000_retire_patient_auth_capabilities.sql`

## Defect (red)

UI patient login was removed, but the capability model remained:

- `link_patient_phone` SECURITY DEFINER executable by `authenticated`
- `patients.user_id` ownership + self-read RLS branch (left intentionally in #56 until #59)
- `change_camp_day` allowed owner self-mutation
- `handle_new_user` would insert `role = 'patient'` profiles
- `profiles.role` DEFAULT `'patient'`
- Public Auth signup enabled in `supabase/config.toml`
- App still selected/passed `user_id` ownership fields

## Phase 1 inventory (local, no PII)

Source: `.scratch/remediation-59/INVENTORY.json`

| Metric | Count |
|---|---:|
| auth.users | 18 |
| profiles.patient | 0 |
| patients with user_id | 0 |
| staff profiles as owners | 0 |
| link_patient_phone overloads | 1 (before fix) |
| handle_new_user triggers attached | 0 |
| profiles.role default | `'patient'::user_role` (before fix) |
| local enable_signup | true (before fix) |

Production Auth signup settings must still be verified in dashboard under **#34**.

## Fix summary

### Database

1. Drop `link_patient_phone` (all overloads)
2. SELECT policy: admin + active-camp staff only (**no** self-read, **no** doctor broad read — #56 preserved)
3. `change_camp_day` staff-only
4. `handle_new_user` no-op; drop any auth.users trigger calling it
5. `profiles.role` DROP DEFAULT
6. Detach ownership (`UPDATE … SET user_id = NULL`) then drop column + indexes + FK
7. `register_patient_idempotent` ignores `p_user_id` (signature kept for callers)

### Application / config

- Remove ownership fields from desk selects and registration fields
- `UserRole` login set = admin | volunteer | doctor
- Login copy for non-staff residual accounts
- `supabase/config.toml`: `auth.enable_signup` + `auth.email.enable_signup` = false
- E2E no longer creates patient Auth users or links `user_id`

### Phase 4 cleanup (for #34)

- `scripts/retire-patient-auth-cleanup.mjs` — dry-run by default
- Execute only with `SNP_PATIENT_AUTH_CLEANUP=1` + `SNP_DEPLOYMENT_AUTHORITY_34=1`

## Verification

| Gate | Result |
|---|---|
| `tests/patient-auth-retirement.db.test.mjs` | 5/5 |
| `npm run test:db` | **37/37** |
| `npm run verify` | pass — lint, **210** unit/DB tests, build, JS budgets |
| `npm run test:e2e` | **14/14** |
| Clean migration replay | **pass** — `supabase db reset --yes` applied through `20260726170000_retire_patient_auth_capabilities.sql` |
| Cleanup dry-run | patient_role_profiles=0; column absent |

### Role / catalog proofs

- Residual `patient` profile SELECT on patients → 0 rows
- Residual patient `change_camp_day` → Not allowed
- Active volunteer `change_camp_day` → ok; disabled volunteer denied
- Auth user insert → no automatic profile; explicit doctor profile works
- Catalog: no `link_patient*`, no `patients.user_id`, no `profiles.role` default

## Remaining for #34

- Confirm production GoTrue signup disabled (dashboard)
- Run inventory + cleanup script with deployment authority if patient profiles exist
- Apply migrations with human production authority
- Enum value `patient` left in `user_role` until zero residual rows (unreachable)

## Rollback

- May restore staff-only provisioning helper if needed
- Must **not** restore `link_patient_phone`, patient self-RLS, or public signup
- Ownership column drop is not trivially reversible without a new migration + data backfill
