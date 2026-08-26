# Spec: Full-system adversarial audit remediation

**Date:** 2026-08-26
**Baseline:** main at e9aa455
**Repository:** Piyushmanyata/snp-camps
**Triage:** ready-for-agent
**Execution mode:** Ordered batches; one append-only database migration; no parallel edits to shared registration, Clinical Desk, SMS, print-window, or verification-harness modules.

## Problem Statement

The application builds and its isolated clean-replay suites are broadly green, but the current audit found twenty defects and hardening gaps across test isolation, database invariants, least privilege, clinical follow-up consistency, SMS delivery truthfulness, registration edge cases, language, accessibility, and development dependencies.

The most serious empirical failure happened before an application assertion: the database test runner accepted any loopback Postgres at its default port. On this workstation that port belonged to another Supabase project, so the runner executed 180 tests against the wrong database and reported 9 passes and 171 failures. The tests contain destructive fixture cleanup. No data loss was proven, but the runner had no project-identity check before starting those tests.

The E2E runner has the same class of problem. With multiple local Supabase projects it abandons key discovery, silently falls back to obsolete keys and a fixed API port, and fails during service-role cleanup. Supplying the SNP project explicitly makes all 38 E2E tests pass, which proves the application flows and isolates the defect to environment discovery.

### Confirmed Audit Findings

| ID | Severity | Finding | Current evidence |
|---|---|---|---|
| F01 | P1 | Database tests can execute destructive cleanup against a different loopback project | scripts/run-db-tests.mjs:5-21,36-73 validates only the host; 34 database test files contain cleanup DELETE or TRUNCATE operations. Runtime reproduction connected to aptus_barcode on port 54322 and ran 180 tests there. |
| F02 | P1 | E2E discovery can select no project or the wrong project, then uses obsolete hard-coded keys and a fixed URL | e2e/run-local.mjs:51-91,118-140; default npm run verify failed in e2e/global-setup.ts:296-298 with “No suitable key or wrong key type” while two local Supabase projects were running. |
| F03 | P2 | Migration comparison treats a reachable foreign or broken schema as an acceptable offline database unless a flag is supplied | scripts/compare-migration-heads.mjs:69-102,163-203 catches every query error as unavailable; package.json:26 does not request a required local comparison. |
| F04 | P1 | Mark seen does not enforce the Print window, and presence can race an admin closing it | supabase/migrations/20260813090000_no_fcfs_queue_presence_is_printed_at.sql:296-349 has no day/window check; supabase/migrations/20260816210000_aadhaar_confirmation.sql:384-429 reads the day gate without locking that row. |
| F05 | P1 | An admin can pre-open a future Camp Day, causing printing to become available automatically at midnight without the required same-day opening action | supabase/migrations/20260816200000_print_window.sql:106-135 and src/components/admin-camp-days.tsx:261-275 accept every day; this conflicts with ADR 0020. |
| F06 | P1 | The Aadhaar confirmation endpoint is a service-role confused deputy that reveals identity fields for unrelated Registrations | src/app/api/desk/aadhaar-confirm/route.ts:17-67 accepts any patient UUID from Registration Staff; supabase/migrations/20260816210000_aadhaar_confirmation.sql:119-125 returns date of birth, Aadhaar last-four, and address even when confirmation is not required. |
| F07 | P1 | Retrying an already-deferred OT resolution can move its schedule while the active slip keeps the previous date and venue | supabase/migrations/20260816230000_ot_schedule_days.sql:140-208 updates the Fulfilment item before reusing the conflicting active slip and records no move event or replacement version. |
| F08 | P2 | The OT rewrite removed per-entry validation for unavailable medicines | supabase/migrations/20260816230000_ot_schedule_days.sql:123-130 enforces only array cardinality; the prior 1–120-character, non-blank validation existed in 20260809120000_clinical_export_and_diagnoses.sql:169-178. |
| F09 | P1 | Reminder and deferral provider failures can produce an HTTP 200 cron result | src/lib/reminder-sms.ts:269-275,348-369 and src/lib/deferral-sms.ts:348-353 increment failure or ambiguity counters without making the job unsuccessful; src/app/api/cron/reminder-sms/route.ts:47-57 returns 200 while both summaries remain successful. |
| F10 | P2 | Cancelled Camps can still receive day-before registration reminders | src/lib/reminder-sms.ts:403-412 filters Registration state and Camp Day date but not Camp active state. |
| F11 | P2 | The manual-exception print page ignores an unavailable service client or a failed confirmation-gate query | src/app/print/[id]/page.tsx:78-98 renders the print surface when the gate cannot be read. The database later refuses the presence write, so privacy remains protected but the desk gets a misleading last-step failure. |
| F12 | P2 | “Not future” date-of-birth validation uses UTC instead of the Asia/Kolkata business date | src/lib/registration-input.ts:15-28 rejects today’s date between 00:00 and 05:29 IST. |
| F13 | P2 | Untrusted registration input accepts contradictory age and date of birth values | src/lib/registration-input.ts:45-83 validates the fields independently; the current registration RPC persists the supplied age at 20260814090000_register_never_writes_waiting.sql:399-431. |
| F14 | P2 | A stalled self-registration request disables the form indefinitely | src/components/self-registration-flow.tsx:107-171 has no timeout or abort boundary while busy remains true. |
| F15 | P2 | Volunteer and Team Lead surfaces mix English with Hinglish | src/app/volunteer/page.tsx:138-180 contains English errors, headings, role labels, and navigation inside a field surface, contrary to CONTEXT.md:109-119. |
| F16 | P3 | Repeated Camp Day controls have indistinguishable accessible names | src/components/admin-camp-days.tsx:223-280 repeats “Seat limit,” “Save,” and printing actions without the Camp Day in the accessible name. |
| F17 | P3 | Admin settings success is visible but not programmatically announced | src/components/admin-settings-panel.tsx:176-181 lacks a status live region, so assistive technology may not receive the save result. |
| F18 | P3 | The clean database schema has a linter warning in the current registration RPC | supabase db lint reports the never-read variable v_existing_request in the current register_patient_idempotent definition at 20260814090000_register_never_writes_waiting.sql:494-508. |
| F19 | P3 | The development dependency graph contains two high-severity denial-of-service advisories | npm audit reports vulnerable brace-expansion and js-yaml versions. Production-only audit reports zero vulnerabilities; the dry-run fix updates three transitive packages without changing direct dependencies. |
| F20 | P3 | The Windows E2E build launcher uses shell argument concatenation and emits Node DEP0190 | e2e/run-local.mjs:170-180 sets shell true; every E2E run emits the security deprecation. |

## Solution

Deliver seven ordered remediation batches:

1. Make every local verification command prove that it targets this repository’s disposable Supabase project before it can create, update, or delete data.
2. Enforce the Print-window state at the database boundary, including concurrent close/print behavior and future-day opening.
3. Restore least privilege and idempotency for Aadhaar confirmation, OT scheduling, medicine validation, and manual-exception printing.
4. Make scheduled SMS outcomes operationally truthful and exclude inactive Camps.
5. Normalize registration dates and ages on the Kolkata business date and make self-registration recover from stalled requests.
6. Repair field-language and accessibility gaps without changing the visual system.
7. Remove the database-lint warning, refresh vulnerable development transitive packages, repair the E2E launcher, update operations documentation, and run every verification seam.

No new runtime or development dependency is required. Do not raise JavaScript budgets. Do not edit historical migrations.

## User Stories

1. As a developer, I want database tests to verify the SNP Camps schema before any fixture setup, so another local project cannot be damaged.
2. As a developer running multiple Supabase projects, I want explicit, documented project and URL overrides, so each suite targets the intended stack.
3. As a CI owner, I want a reachable schema mismatch reported as a mismatch, so it cannot be described as an offline skip.
4. As a release owner, I want the full verification command to fail before database tests when the required local project is absent or stale.
5. As a volunteer, I want Mark seen refused while the Print window is closed, so a stale screen cannot write outside operating hours.
6. As an admin closing printing, I want that close serialized against an in-flight presence write, so the final database state has one unambiguous winner.
7. As an admin, I want future Camp Days impossible to pre-open, so every day requires an intentional same-day opening action.
8. As a patient, I want Registration Staff to receive only the identity fields needed for my current manual-exception confirmation, so unrelated Aadhaar details stay private.
9. As a volunteer, I want a normal Registration to return only “confirmation not required,” so its date of birth, Aadhaar last-four, and address are not exposed by the confirmation route.
10. As a Clinical Desk Operator, I want an identical OT resolve retry to return the original schedule and slip unchanged, so retrying is safe.
11. As a Clinical Desk Operator, I want a different OT schedule on an already-resolved item to require the correction workflow, so the active slip and schedule never disagree.
12. As a patient, I want a replaced OT schedule to produce an auditable replacement slip, so the paper instructions match the database.
13. As a Clinical Desk Operator, I want each unavailable medicine name to be non-blank and bounded, so unusable fulfilment history cannot be saved.
14. As an SMS operator, I want any failed or ambiguous dispatch reflected in the cron HTTP status, so monitoring can alert.
15. As an SMS operator, I want ambiguous delivery recorded without blind automatic resend, so the system reports uncertainty without creating duplicates.
16. As a patient, I do not want reminders for a cancelled Camp, so I am not sent to an event that will not run.
17. As a volunteer, I want a confirmation-service outage shown before the print surface, so the desk does not proceed into a guaranteed refusal.
18. As a parent registering a newborn just after midnight in India, I want today’s date of birth accepted.
19. As a patient with a scanned Aadhaar card, I want age derived from the authoritative date of birth, so my printed identity cannot contradict itself.
20. As a registration API owner, I want tampered age and date-of-birth combinations rejected or normalized at the server and database boundaries.
21. As a self-registering patient on a poor network, I want a stalled request to time out with a retry path, so the form never remains locked forever.
22. As a self-registering patient retrying after a timeout, I want the same request ID reused, so an unknown server success cannot create a duplicate.
23. As Registration Staff, I want the entire field surface in consistent Hinglish, so operational errors and actions are not language-mixed.
24. As a screen-reader or speech-input user, I want each Camp Day control named with its date, so I can target the correct control.
25. As a screen-reader user, I want an admin-settings save announced as a status result.
26. As a database maintainer, I want a warning-free clean schema, so new warnings remain meaningful.
27. As a security maintainer, I want development tooling free of known high-severity advisories.
28. As a Windows developer, I want E2E child processes launched without unsafe shell argument concatenation.
29. As a domain owner, I want all fixes to preserve registered → seen, Presence as printed_at, the two primary desk actions, the ten-minute Undo, the separate Clinical Desk, and paper as the prescribing source.
30. As a production owner, I want every schema change append-only and replayed from a clean database before merge.

## Implementation Decisions

1. **Verification target identity.**
   - Add a read-only database preflight before the database test child process starts.
   - For an automatically discovered local target, the preflight must first match the configured `project_id` to the owning Supabase container/project. An explicit `SNP_TEST_DATABASE_URL` is deliberate target authorization, but it must still pass every safety check below.
   - The preflight must verify loopback, the expected migration ledger head, the current readiness-probe head, and at least one SNP-specific catalog invariant.
   - Reuse `BLOCKER[UNSAFE-DB-TARGET]` for connection, foreign-schema, stale-schema, missing-probe, and head-mismatch failures, and include the specific preflight reason in the message.
   - The child process must not spawn when the preflight fails.
   - Keep the existing explicit test-database URL override and document it for parallel local stacks; do not solve a workstation collision by permanently changing the repository’s default ports.

2. **Migration comparison and E2E discovery.**
   - The full verification command requires a local migration comparison.
   - Manual offline comparison may retain its current repo-only mode, but a successful connection followed by a schema/query error is never “offline.”
   - E2E discovers the project declared by the repository configuration, including Docker-mapped API port and current anon/service credentials.
   - Multiple projects without an unambiguous match fail with one actionable error. Never guess, select the only unrelated container, or fall back to fabricated credentials.
   - Retain explicit E2E project, URL, and credential overrides for CI.

3. **One append-only database migration.**
   - Redefine the current Print, Mark seen, print-window setter, Aadhaar confirmation, Clinical resolve, Clinical slip replacement, and registration functions in one new migration.
   - Preserve every existing argument signature unless a privacy repair requires replacement. When a signature changes, drop the exact old signature, recreate it, restore grants, and prove no overload residue remains.
   - Preserve existing patient-first lock order. Lock the relevant Camp Day before evaluating the window so closing and desk writes serialize.
   - Already-seen and already-printed idempotent outcomes keep their original attribution and timestamps.
   - Opening a Print window requires the Camp Day to equal today in Asia/Kolkata. Closing remains allowed at any time.

4. **Aadhaar confirmation boundary.**
   - Use an explicit state matrix: a normal or already-confirmed active Registration returns minimal `not_required`; an active manual-exception Registration awaiting confirmation permits inspect and commit; inactive, missing, or otherwise unrelated records are denied.
   - `not_required` returns no date of birth, Aadhaar last-four, address, or other confirmation-only patient data.
   - Prefer caller-authenticated database execution over service-role delegation. The database derives the actor from the authenticated session and enforces Registration Staff roles.
   - The print page treats a missing client, failed query, or malformed gate response as unavailable and renders the existing refusal/retry surface.

5. **Clinical resolution consistency.**
   - An exact OT retry is idempotent only when outcome and schedule match the stored item; return the existing active slip unchanged.
   - A different schedule is a conflict and must use the reasoned correction path. Extend that transaction to lock the old and new schedule days in deterministic order, refuse a full destination, release and claim seats atomically, update `fulfilment_items.ot_schedule_day_id`, record the correction event, cancel the active slip, and create the replacement with the same new date/venue snapshot.
   - Restore non-blank, trimmed, 1–120-character validation for each unavailable medicine and the existing 1–12 item limit.

6. **SMS truthfulness.**
   - Any failed or ambiguous registration-reminder or deferral delivery makes its job summary unsuccessful.
   - The cron route returns non-2xx when either summary is unsuccessful while retaining exact sent, skipped, failed, and ambiguous counts.
   - Ambiguous deliveries remain non-retryable without an explicit reconciliation decision.
   - Candidate selection requires an active Camp in addition to the existing date, lifecycle, phone, and ledger rules.

7. **Registration normalization and recovery.**
   - Reuse the exported `kolkataTodayIso(now)` helper for “today,” and remove or redirect the duplicate private implementation in `src/lib/print-window.ts`.
   - When date of birth exists, derive age in completed years at the database boundary and return/store that value. Do not trust a contradictory client age.
   - Preserve manual registration without date of birth, where age remains the declared bounded value.
   - Give self-registration a finite request timeout using the native platform abort API. Timeout copy is Hinglish, the busy state clears, entered data remains, and retry reuses the same idempotency request ID.

8. **Language and accessibility.**
   - Translate field-only English copy on Volunteer and Team Lead surfaces into the project’s existing Hinglish vocabulary; keep admin-only surfaces English.
   - Give each repeated Camp Day input and action a date-specific accessible name without changing visible compact labels.
   - Announce admin-settings success with a polite status region and do not duplicate the existing error alert.

9. **Tooling cleanup.**
   - Remove the unused registration variable while redefining the function for the behavioral fixes.
   - Refresh the lockfile to the non-vulnerable brace-expansion and js-yaml transitive versions reported by the audit dry run; do not add an override unless normal lockfile resolution cannot produce those versions.
   - Replace the Windows shell-based npm build spawn with an argument-safe native launch that works on supported Windows and non-Windows hosts.

10. **Documentation.**
    - Update README verification instructions with project fingerprint behavior, the explicit parallel-stack overrides, and the difference between offline comparison, local verification, and clean replay.
    - Update operations documentation with cron failure semantics and alert expectations.
    - No new ADR or domain term is required because this work enforces accepted decisions rather than changing them.

## Testing Decisions

Good tests assert observable behavior at the highest existing seam. They must not depend on source-text regexes, private helper shapes, timing sleeps, or optional visibility branches. A skipped database test is a failure.

1. **Harness unit and integration tests**
   - Extend the existing database-runner tests to prove remote hosts, foreign loopback schemas, a same-schema wrong local project, missing probes, stale heads, and connection failures all block before child-process spawn; separately prove that an explicit loopback override is treated as deliberate authorization only after all schema safety checks pass.
   - Add E2E-runner tests for zero, one correct, one incorrect, and multiple local Supabase projects. Assert selected project URL and credential source without printing secrets.
   - Add a Windows launcher test that fails on DEP0190 or shell-based argument concatenation.

2. **Database runtime tests**
   - Extend Print-window tests for closed-window Mark seen, future-day open refusal, already-seen idempotency, and a concurrent close versus presence write with deterministic final outcomes.
   - Extend Aadhaar-confirmation tests across the full matrix: normal and already-confirmed active Registrations return minimal `not_required`; pending active manual exceptions permit inspect/commit; inactive, missing, and unrelated records are denied.
   - Extend OT schedule tests for same-schedule retry, different-schedule conflict, A→B correction, old-seat release, new-seat claim, full-destination refusal, item/slip snapshot equality, and concurrent last-seat attempts.
   - Extend Clinical tests for blank, whitespace-only, 121-character, 12-item, and 13-item unavailable-medicine arrays.
   - Keep exact role, grant, RLS, function-signature, Realtime-absence, and migration-head checks.

3. **Route and job tests**
   - Test reminder and deferral summaries for sent, skipped, failed, ambiguous, claim failure, ledger-completion failure, mixed batches, and inactive Camps.
   - Test manual-exception print gating for missing configuration, query error, malformed data, required confirmation, override, and not-required outcomes.
   - Freeze the clock around 23:59 UTC, 00:00 IST, 05:29 IST, leap day, birthday boundaries, and future dates.
   - Test contradictory age/date-of-birth payloads on manual, scanned-desk, and self-registration routes and prove the database stores the derived value.

4. **Automated Playwright tests**
   - Add a never-settling self-registration request, timeout recovery, same-request-ID retry, and late-response suppression.
   - Add mandatory Hinglish assertions on Volunteer and Team Lead headings, navigation, errors, stale states, and recovery actions.
   - Add date-qualified accessible-name checks for multi-day controls and a live-region check for admin save success.
   - Keep the existing role, scanner, print, Clinical line, CSP, JavaScript-island, touch-target, contrast, zoom, and timing tests.

5. **Final gates**
   - The full npm audit reports zero known vulnerabilities across production and development dependencies.
   - Database lint reports no warnings on a freshly replayed schema.
   - Clean migration replay passes with zero skipped tests.
   - Lint, typecheck, unit tests, database tests, production build, JavaScript budgets, automated E2E, and environment drift all pass in one full verification command.
   - Run correctness and simplicity reviews in parallel, fix every confirmed finding, then rerun the affected targeted tests and the full gate.

## Out of Scope

- No FCFS queue, waiting state, public status token, patient account, patient login, or public patient-status route.
- No change to paper as the prescribing source, the separate Clinical Desk operational record, the Clinical Desk Operator role, or the four Clinical lines.
- No removal of the ten-minute Undo mark seen path.
- No attempt to detect print-dialog cancellation or printer hardware failure; ADR 0019 deliberately records Presence before opening the dialog.
- No production database reset, destructive historical-migration edit, enum-value removal, remote migration application, or unreviewed data deletion.
- No new i18n framework, design-system rewrite, broad refactor of high-complexity modules, live MSG91 send, manual browser session, or load-test expansion.
- No permanent repository port change solely to accommodate another project on one workstation.

## Further Notes

### Audit execution evidence

- Clean working tree and baseline main at e9aa455 before audit work.
- Lint passed.
- TypeScript no-emit check passed.
- Unit suite passed 511 of 511 with 0 failed and 0 skipped.
- Clean replay applied all 94 migrations and passed 179 of 179 database tests with 0 failed and 0 skipped.
- Production build generated 32 static pages successfully.
- All JavaScript route budgets passed.
- Explicitly project-bound automated E2E passed 38 of 38 tests.
- Environment drift check passed with 25 documented static environment reads.
- Production dependency audit reported 0 vulnerabilities.
- Full dependency audit reported 2 high-severity development-only vulnerabilities with a three-package lockfile-only fix.
- Fresh-schema database lint reported one unused-variable warning.
- Default full verification failed at E2E project discovery; the explicitly project-bound full verification then passed and is the required implementation baseline.

### Deliberately rejected audit candidates

- Clinical Desk operational records and the Clinical Desk Operator are accepted current domain behavior, not a return to digital prescribing.
- Undo mark seen is an accepted ten-minute correction path, not a forbidden third primary desk action.
- Presence-before-print and printing after a partial success are accepted by ADR 0019; browser cancellation is not observable.
- A missing active-camp snapshot degrading to the documented empty state is an accepted prior decision.
- Non-blocking registration SMS does not fail desk registration; no page-unload loss was admitted without a direct reproduction.

The temporary 5452x Supabase port assignment used to isolate this audit was removed after verification; the repository defaults were restored.
