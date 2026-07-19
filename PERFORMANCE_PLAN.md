# SNP Camps Deep Optimization Plan

## Project Completion Goal

Make the SNP Camps Next.js/Supabase application leaner, faster, and safer
without changing its registration, queue, authentication, or staff-scan
semantics. Completion requires verified fixes for every confirmed correctness
and performance defect in the selected scope, green repository checks, a
successful transactional database rollout and post-rollout probes, visual
critical-path validation, a refreshed Graphify map, and a clean commit pushed
to `origin/main`.

### In Scope

- Repair the live/repository registration RPC contract drift, preserving the
  claim-token flow and indexed duplicate checks.
- Correct active-camp scoping for doctor KPIs and reduce its scan work.
- Remove redundant client refreshes and render-time state updates in the live
  queue and seat board.
- Reject unsafe registration numbers and invalid seat limits before they reach
  PostgREST/Postgres.
- Fail closed when the registration profile upsert fails.
- Remove the audited vulnerable nested PostCSS version through a compatible
  lockfile override, without changing the Next.js major or runtime contract.
- Preserve public snapshot caching, request-level Supabase deduplication, RLS,
  security-definer boundaries, accessibility semantics, and current UI.
- Apply only idempotent, evidence-backed SQL to project
  `ruklmrzpyutvefancsgo` through the repository's existing script lineage.

### Out of Scope

- New dependencies, state-management libraries, realtime subscriptions,
  service workers, CDN changes, or a broad visual redesign.
- Destructive patient/account data changes, auth-user deletion, or speculative
  index removal based only on low current usage on the tiny live dataset.
- Changing queue ordering, role permissions, claim lifetime, or public API
  response semantics except to restore the documented claim-token contract.
- Load-testing production or generating persistent test records.

### Constraints

- Next.js 16.2.10, React 19, Supabase/Postgres 17, and Vercel remain the
  supported stack.
- No secrets may be printed, committed, or included in artifacts.
- Supabase CLI is unavailable; use the existing flat SQL plus
  `scripts/apply-enhancements.mjs` lineage.
- Execution mode is single-agent/sequential with explicit batch checkpoints.
- Existing user changes and unrelated files must remain untouched.

## Verified Baseline and Findings

- Git baseline was clean on `main` at `7c5b2a6`.
- `npm run verify` passed: lint, 5 core tests, and the Next production build.
- `next experimental-analyze --output` completed successfully.
- Graphify found central shared nodes in `getSessionProfile`, Supabase client
  creation, `isStaff`, `checkRateLimit`, `SeatBoard`, `LiveQueue`, and QR
  scanning; no import cycles were reported.
- LeanCTX code-health score was 81/100; the principal complexity hotspots are
  `PatientForm`, patient-account registration, patient-register, QR scanning,
  and the admin patient search.
- The live DB probe found 4 patients, 1 camp, and 1 camp day, so low index
  usage is not sufficient evidence for dropping indexes.
- A transactional live RPC probe reproduced a confirmed defect:
  `register_patient` returns six columns but delegates to a five-column
  `register_patient_authorized_impl`, producing PostgreSQL error `42804`.
- The live implementation also evaluates phone/name expressions over table
  columns while holding the camp-day capacity lock, bypassing the generated
  normalized-column indexes.
- `doctor_my_counts` counts `seen_total` across all camps while the doctor page
  displays it as the active-camp total.

## Acceptance Criteria

1. Public snapshot behavior remains one cached RPC read with the existing five
   second freshness bound.
2. `register_patient` returns `id`, `reg_no`, `full_name`, `camp_day_id`,
   `day_date`, and `claim_token` for both staff and OTP self-registration.
3. A transactional registration smoke probe inserts no persistent test row,
   returns the six-column shape, and rolls back cleanly.
4. Duplicate checks use `phone_normalized` and `full_name_normalized`, and
   doctor KPI queries restrict work and totals to the requested camp.
5. Invalid/unsafe numeric input is rejected locally and profile-upsert errors
   fail closed before patient insertion.
6. Queue assignment causes one authoritative refresh path, while server-prop
   synchronization no longer calls state setters during render.
7. The production dependency audit has no remaining high/critical findings and
   the known nested PostCSS advisory is removed by the lockfile override.
8. `npm run verify`, production analyze, database post-checks, and browser
   critical-path checks pass.
9. The final diff contains only planned files, is reviewed for security,
   accessibility, performance, and scope, and is pushed to `origin/main`.

## Skill Manifest

| Skill | Purpose | Phase(s) | Invocation point | Expected evidence |
|---|---|---|---|---|
| ponytail | Minimal, root-cause changes; avoid speculative abstractions | all | Before each edit/review | Small diff, no unrelated refactor |
| lean-ctx | Compressed shell/read/search output and context ledger | all | Recon, builds, review | Focused excerpts and compressed checks |
| graphify | Dependency, call-path, and impact mapping | recon/review | Before deep reads and after structural edits | Query results plus refreshed graph |
| vercel-react-best-practices | Cache/deduplication, waterfall, bundle, and rerender review | plan/UI | Before implementation and final review | No duplicate refresh path; analyze output |
| nextjs-app-router-patterns | Server/client boundary and App Router behavior | plan/UI | Route and component changes | Server behavior preserved |
| nextjs-react-typescript + react-dev | React 19 and TypeScript-safe implementation | UI/API | Before edits | Type/lint/build green |
| performance | Runtime budgets and measurement discipline | all | Plan and verification | Analyze/build/browser evidence |
| supabase | Safe RPC, RLS, function, and rollout handling | DB/API | Before SQL/API edits | SQL apply and function probes |
| supabase-postgres-best-practices | Indexed predicates, locking, statistics, and query shape | DB | Before SQL edits | Explain/index/function evidence |
| sql-code-review | SQL correctness and migration review | DB/final | Before rollout | Re-runnable, permission-safe SQL |
| accessibility | Keyboard, labels, live regions, error semantics | UI/final | After component edits | Browser/a11y checks |
| playwright-cli/browser-automation | Critical-path and visual validation | final | After production start | Screenshots, console/network check |
| code-review | Independent diff and regression review | batches/final | After each batch and before push | Findings resolved or documented |
| adversarial-review + grill-me | Pre-mortem and hostile edge-case review | plan/final | Readiness gate and final review | Risk ledger and mitigations |
| github + yeet | Main-branch commit/push workflow | final | Before push | Commit and remote status |
| deploy-to-vercel | Production/preview deployment awareness | final | After push | Auto-deploy status checked; no unsanctioned deploy |

## Context and Graph Strategy

- Query the existing Graphify graph before broad repository reads; refresh it
  after SQL/function and component structure changes.
- Use LeanCTX `read`, `grep`, `health`, `smells`, and compressed command output;
  keep secrets redacted and never read `.env.local` into model context.
- Use Ponytail as the change gate: fix the root cause, reuse existing helpers,
  prefer deletion/simplification, and add only focused regression coverage.

## Batch Map

### Batch 1 — Contract and query correctness

Owned files: `supabase/lean-perf.sql`, `tests/core.test.mjs` if needed, and
the database apply/probe scripts only if a small verification helper is
necessary. Rebuild the normalized registration implementation and wrapper as
one six-column contract; optimize predicates; scope doctor counts. Apply in a
transaction, verify function signatures/source/index usage, and roll back on
failure.

### Batch 2 — Client/API correctness and request reduction

Owned files: `src/lib/qr.ts`, `src/components/qr-scanner.tsx`,
`src/components/admin-patients.tsx`, `src/app/patient/login/page.tsx`,
`src/components/admin-camp-days.tsx`, `src/components/seat-board.tsx`,
`src/components/live-queue.tsx`, and `src/app/api/patient-register/route.ts`.
Add safe numeric parsing, derived server-prop synchronization, a single queue
refresh path, lean queue projections, and fail-closed profile upsert handling.

### Batch 3 — Integrated verification and adversarial review

Run lint/tests/build/analyze, refresh Graphify, run SQL post-checks, start the
production server, exercise public/register/login/staff routes with browser
checks, inspect console/network errors, and review the full diff. Rework or
replan any failed evidence before continuing.

### Batch 4 — Publish and handoff

Run final clean-state checks, confirm database/code compatibility, use the
GitHub push workflow to commit and push `main`, inspect remote/Vercel status,
then report commit, DB, graph, test, and visual evidence.

## Adversarial Pre-mortem

| Failure mode | Why plausible | Mitigation |
|---|---|---|
| Registration still fails after rollout | SQL lineage has multiple historical function signatures | Drop/recreate both exact signatures in one transaction; call the wrapper and inspect six result fields |
| Claim token is lost or exposed | Wrapper/impl contract is being rebuilt | Preserve public wrapper grants and token generation only for non-staff callers; verify returned shape without printing token |
| Capacity race regresses | Registration checks run around a locked day | Keep `FOR UPDATE`, authoritative capacity check, and unique indexes; do not move insertion to the API |
| KPI numbers change unexpectedly | Existing totals mix active/all camps | Scope only doctor totals to the requested camp; keep volunteer labels/semantics unchanged |
| Queue UI becomes stale | Removing the duplicate queue fetch could stale dashboard stats | Keep one authoritative `router.refresh()` after optimistic local removal |
| Stale props overwrite a user action | Local state and server props can diverge | Derive server props when the source identity changes and use server refresh as the source of truth |
| Tiny live DB misleads index decisions | Current table has only four rows | Do not drop uncertain indexes; use predicate/index alignment and EXPLAIN with planner caveat |
| Visual or auth regression escapes build | Next build does not exercise browser state/cookies | Run browser critical paths, keyboard/error checks, and inspect console/network output |

## Rollback

- Code: revert the single bounded commit if post-push checks fail.
- DB: restore the prior `register_patient`/impl definitions from the checked-in
  migration lineage, or apply the inverse function migration; no patient data
  is deleted by this work.
- UI/API: each batch is isolated and can be reverted by file-level commit
  rollback before publish.

## Completion Evidence Checklist

- [x] Clean baseline, Graphify queries, LeanCTX health/smells, and DB read-only
  diagnostics recorded.
- [x] SQL function contract probe passes and leaves no test row.
- [x] SQL predicate/index and doctor KPI verification passes.
- [x] `npm run verify` and `next experimental-analyze` pass after changes.
- [x] `npm audit --omit=dev` is clean after the PostCSS override.
- [x] Browser critical paths, responsive checks, HAR status checks, and HTTP health checks pass; direct console capture was unavailable in the installed CLI.
- [x] Graphify refreshed after structural changes.
- [ ] Final diff reviewed; commit pushed to `origin/main`.
