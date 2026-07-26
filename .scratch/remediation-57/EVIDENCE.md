# #57 Evidence — Enforce waiting-before-seen in assign_patient_doctor

Date: 2026-07-26  
Base: local uncommitted work on top of #56 (also uncommitted)  
Worktree: `snp-camps` @ `d4a9827` + local changes

## Defect (red) — reproduced before fix

Authenticated doctor JWT against a future-day pre-registered patient:

- `assign_patient_doctor` returned `error_code = null`, `queue_status = seen`
- Row was mutated to seen (would set `seen_at` / `seen_by`)
- Root cause: function allowed `queue_status in ('registered', 'waiting')` then wrote seen, and backfilled `checked_in_by` with the doctor when null

Unit test suite before migration: 2 failures asserting `check_in_required` (doctor + volunteer registered paths). Waiting / already_seen / concurrency paths already green.

## Fix summary

### Database (`20260726160000_assign_waiting_before_seen.sql`)

1. After terminal `already_seen`, if status is `registered` return structured `check_in_required` without UPDATE
2. Only `waiting` may proceed to doctor selection and UPDATE to `seen`
3. UPDATE no longer backfills `checked_in_by` (check-in remains its own event)

### Application

1. `assignPatientDoctorWithRetries` maps `check_in_required` to worker copy once (no auto-retry)
2. Doctor QR review: registered patients show check-in instruction; **no Mark seen button**
3. Waiting doctor path unchanged (Mark seen)

## Verification

| Gate | Result | Notes |
|---|---|---|
| Red DB test (pre-migration) | fail as expected | registered assign returned `error_code null` |
| Role DB suite `assign-waiting-before-seen.db.test.mjs` | **5/5** | doctor/volunteer reject; waiting→seen; already_seen; concurrent |
| `npm run test:db` | **32/32** | includes #56 + #57 suites |
| `npm run verify` | pass | lint, **197** unit/DB tests, build, JS budgets |
| `npm run test:e2e` | **14/14** | doctor fixture already `waiting` |

### Red/green assertions (authenticated roles)

- Doctor + registered → `check_in_required`; row still registered; no `seen_at`/`seen_by`/`queued_at`/false `checked_in_by`
- Volunteer + registered + doctor_id → same rejection
- Waiting → seen once; original `queued_at` + `checked_in_by` preserved; `seen_by` = attending doctor
- Repeat assign → `already_seen`, original doctor immutable
- Two concurrent doctors → exactly one first assignment; other terminal; single `seen_by`

## Rollback

- Function-only reverse migration is allowed **only if** it still rejects `registered → seen`
- Never re-authorize registered assignment
- UI can temporarily surface generic safe error if rolled back ahead of DB

## Remaining

- Not committed / not pushed / not production-migrated (#34)
- #58 may depend on registered rejection for full scanner E2E
- #68 final lifecycle contract includes this invariant
