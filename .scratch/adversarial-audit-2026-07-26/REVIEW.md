# SNP Camps adversarial closeout review

Date: 2026-07-26  
Reviewed commit: `d4a9827` on `main`  
Repository: `Piyushmanyata/snp-camps`

## Executive conclusion

The repository is build-green but not closeout-safe. The baseline verification command,
all 187 application tests, all 14 browser tests, all 20 database tests, the production
build, JavaScript budgets, and the production-dependency audit passed. Despite that,
the review reproduced two high-impact database defects under real database roles:

1. A doctor can directly select unrelated patients' identifying and contact data,
   Aadhaar suffix, and bearer status token.
2. A doctor can move a patient directly from `registered` to `seen`, bypassing the
   required physical check-in transition and manufacturing check-in attribution.

The same ticket wave also introduced an architectural contradiction: ticket #53
required polling and explicitly rejected Realtime, while the current desk data path
uses direct patient Realtime as its primary mechanism and has tests that preserve that
implementation. Scanner cancellation, retry classification, lost-slip recovery,
registration printing, section isolation, A4 batching, SMS delivery, concurrency,
readiness, accessibility, queue position, bundle splitting, documentation, and closure
evidence all contain independently actionable gaps.

This is not a claim that the closed work had no value. The project now has a substantial
test suite, a coherent operational UI, database functions with generally careful
`SECURITY DEFINER` hygiene, idempotency foundations, and working happy-path browser
flows. The failure was verification strategy and cross-ticket integration: source
wiring and aggregate green commands were repeatedly treated as proof of runtime,
authorization, concurrency, print, and accessibility behavior.

## Review method

The review combined:

- the complete open/closed GitHub ticket history through #54;
- repository and dependency graphing (790 nodes, 1,994 edges, 153 code files);
- focused source and migration review;
- current-branch diff/history analysis;
- full unit, build, E2E, and real-database baselines;
- role-authentic database probes inside rolled-back transactions;
- workflow/state-machine analysis;
- browser and rendered-layout review;
- official Supabase, PostgreSQL, and local Next.js documentation;
- three independent specialist passes over data/security, frontend workflows, and
  ticket-to-implementation fidelity;
- an independent fixed-point review of the new remediation tickets.

No production mutation, deployment, destructive database operation, or source-code fix
was performed. Synthetic database probes were rolled back.

## Baseline evidence

| Check | Result |
|---|---|
| `npm run verify` | Pass: lint, 187 tests, production build, JS budgets |
| `npm run test:e2e` | Pass: 14/14 |
| `npm run test:db` | Pass: 20/20, no skips |
| `npm audit --omit=dev` | Pass: zero production dependency vulnerabilities |
| Git worktree before review | Clean |
| Git worktree after review | Source tree unchanged; only this untracked audit directory |
| Graphify | Code graph succeeded; semantic-document expansion unavailable due connection failure |
| LeanCTX | CLI available and used; referenced global instruction file was missing, so manual degraded-mode discipline was applied |

A passing baseline is useful regression evidence, but it does not invalidate the
findings below. Several defects are outside the exercised assertions, and some tests
assert the faulty wiring itself.

## Severity-ranked findings

### Critical — direct doctor access exposes patient PHI and bearer status tokens

Evidence:

- The active patient Realtime migration creates an authenticated patient `SELECT`
  policy that includes camp crew; doctors are camp crew.
- Baseline grants expose patient identifying/contact columns to `authenticated`.
- The status-token migration additionally grants the bearer `status_token` column.
- A real role-authentic probe using `SET LOCAL ROLE authenticated` showed a doctor
  reading an unrelated synthetic patient's name, address, phone, email, Aadhaar suffix,
  and a 32-character status token. The transaction was rolled back.

Relevant source:

- `supabase/migrations/20260725234000_patients_realtime_desk.sql:25`
- `supabase/migrations/20260726090000_patients_status_token_drop_passcode.sql:22`
- `supabase/migrations/20260725134338_baseline_current_schema.sql:2090`
- `src/lib/camp-desk-realtime.ts:21`
- `src/lib/use-camp-desk-realtime.ts:20`

Why the earlier approach failed:

Postgres row-level security restricts rows, not individual columns. Direct Realtime
Postgres Changes also requires row `SELECT` permission. Expanding patient table access
to make Realtime work therefore crossed the application's least-privilege boundary.
The status token is itself an authorization bearer and must never be available in the
doctor's broad patient read path.

Resolution: #56.

### High — doctor assignment bypasses physical check-in

Evidence:

- The doctor assignment RPC permits both `registered` and `waiting`.
- It unconditionally writes `seen`, `seen_at`, `seen_by`, and `checked_in_by`.
- A real authenticated-doctor probe moved a registered patient to seen with no
  `queued_at` and attributed check-in to the doctor. The transaction was rolled back.

Relevant source:

- `supabase/migrations/20260725134338_baseline_current_schema.sql:229`
- `supabase/migrations/20260725134338_baseline_current_schema.sql:249`
- `supabase/migrations/20260725134338_baseline_current_schema.sql:284`

Why the earlier approach failed:

The implementation preserved an earlier "scan without prior print" shortcut after the
product adopted a two-round lifecycle. The closed ticket's blocker required the
`waiting → seen` transition, but the RPC contract and database tests were not updated
to enforce it.

Resolution: #57.

### High — polling-only architecture was replaced by direct Realtime

Evidence:

- Ticket #53 explicitly said to keep polling and not use Realtime.
- Current desk hooks subscribe to `postgres_changes`.
- Polling is used as reconnect fallback rather than as the single freshness owner.
- Source-wiring tests assert the presence of the Realtime subscription.

Relevant source:

- `src/lib/camp-desk-realtime.ts:21`
- `src/lib/use-camp-desk-realtime.ts:20`
- `tests/camp-desk-realtime.test.mjs:33`

Impact:

Beyond the security exposure, two freshness owners create race and reconciliation
complexity. Reference-identity and stale-response problems remain in queue/seat/admin
consumers, so older snapshots can overwrite newer state.

Resolution: #56 and test consolidation in #72.

### High — QR camera lifecycle is not cancellation-safe

Evidence:

- Detection awaits browser/decoder work and applies its result without checking a
  session-generation token after each asynchronous boundary.
- Stop or unmount can therefore be followed by a stale success/error update.
- The Doctor flow does not prove scanning two patients consecutively with one camera
  session.
- Several terminal scanner errors remain retryable indefinitely.

Relevant source:

- `src/components/qr-scanner.tsx:467`
- `tests/qr-detector.test.mjs:27`

Resolution: #58.

### High — retired patient Auth surface remains active

Evidence:

- Patient `user_id`, Auth linkage RPCs, authenticated self-read policy branches,
  Auth-user lookups, and public signup-era registration parameters remain in the
  migration chain.
- A product change retired patient accounts in favor of bearer status tokens, but the
  database contract was not completely retired.

Relevant source:

- `supabase/migrations/20260725220000_link_patient_phone_household_candidates.sql:8`
- `supabase/migrations/20260725220000_link_patient_phone_household_candidates.sql:47`
- `supabase/migrations/20260725134338_baseline_current_schema.sql:1340`
- `supabase/migrations/20260725134338_baseline_current_schema.sql:1609`

Resolution: #59.

### High — retry logic discards structured error identity

The data layer flattens database errors into prose, and UI retry decisions inspect
message text. Terminal authorization, validation, conflict, and capacity failures can
be retried as though they were transient. Message wording changes can also silently
change behavior.

Resolution: #60.

### High — lost-slip recovery is not robust or truthful

The search path is exact/prefix-oriented rather than tolerant of the requested
misspelling class. Query errors collapse into empty results, making system failure look
like "no patient." Check-in is single-attempt, some raw database errors reach the UI,
and scanner terminal failures have no bounded recovery contract.

Resolution: #61.

### High — register-and-print can report success when printing never opened

The print window is opened only after the registration RPC and possible retry delay.
That loses the synchronous user-gesture relationship browsers use for popup
permission. The returned window is not treated as a success condition, so a blocked
popup can still result in a misleading completion state without a reliable same-request
retry.

Relevant source:

- `src/components/patient-form.tsx:312`

Resolution: #62.

### High — section failures are not isolated

The generic section retry calls `router.refresh()`, which re-runs the full route tree.
Admin data failure can still throw through Suspense into the route/global error
boundary rather than preserve healthy sections. Raw infrastructure messages remain in
some desk/admin paths.

Relevant source:

- `src/components/section-load-error.tsx:9`
- `src/components/section-load-error.tsx:32`
- `src/components/admin-patients.tsx:299`

Resolution: #63.

### High — A4 batching and print geometry were not actually proven

The A4 route renders four copies of one patient's slip rather than batching four
distinct patients. Existing tests exercise screen layout rather than the browser's
print medium. Thermal output uses a fixed 110 mm page box with hidden overflow, so
maximum-length content can clip. Global print CSS also affects route-specific
measurement.

Resolution: #64.

### High — SMS delivery state is not durable or operationally truthful

Registration failure information is process-local and browser-triggered sends are
fire-and-forget. Reminder ownership is claimed before/around provider work in a way
that cannot distinguish sent, failed, and ambiguous outcomes durably. A cron request
can report success when the job failed internally.

Relevant source:

- `src/lib/reminder-sms.ts:103`
- `src/lib/reminder-sms.ts:355`
- `supabase/migrations/20260726140000_reminder_sms_sent_at.sql:6`

Resolution: #65.

### High — capacity edits race registrations

Camp-day capacity updates and patient registrations do not share a serialization
boundary. A concurrent edit can accept a capacity below the ultimately registered
count or allow a registration based on stale capacity.

Resolution: #66.

### High — likely-duplicate checks race concurrent registration

The warning/override check is performed before insertion without a serialization key.
Two matching requests can both observe no duplicate and insert concurrently. Explicit
operator override must remain possible, but unintentional concurrent duplicates need
a deterministic lock boundary.

Relevant source:

- `supabase/migrations/20260726130000_likely_duplicate_warn.sql:49`

Resolution: #67.

### Medium — readiness can be green when migration discovery failed

Migration-head failure becomes a nullable display value and does not necessarily
participate in the final ready decision. The schema probe does not cover the complete
runtime contract or durable reminders. Incremental database success is not proof that
the full chain replays cleanly.

Resolution: #68.

### Medium — source accessibility checks missed rendered failures

Rendered controls remain below the project's 48×48 operational target, including the
Seat Board refresh control. Scanner guidance uses a small, opacity-reduced foreground
whose effective contrast on its tinted background is approximately 3.38:1. Admin
controls contain additional undersized cases. These require computed browser checks.

Relevant source:

- `src/components/seat-board.tsx:135`
- `src/components/qr-scanner.tsx:833`

Resolution: #69.

### Medium — public queue position can be wrong or fabricated on error

The status page performs a separate count using `queued_at <= current queued_at`,
ignores the count-query error, and does not apply the operational queue's deterministic
tie-break. Equal timestamps can produce contradictory positions.

Relevant source:

- `src/app/s/[token]/page.tsx:58`

Resolution: #70.

### Medium — dynamic-import syntax was mistaken for browser code splitting

Dynamic imports from Server Components do not, by themselves, prove that the client
island is split in the current Next.js behavior. Many operational components use this
pattern, while route client budgets remain roughly 450 kB and no browser network proof
shows optional chunks being deferred.

Relevant source:

- `src/app/volunteer/page.tsx:30`
- `src/app/doctor/page.tsx:20`
- `src/app/admin/page.tsx:19`

Resolution: #71.

### Medium — implementation-text tests preserve defects

Tests assert imports, hook wiring, strings, and Realtime presence. These can pass while
behavior is wrong and can prevent a correct architectural reversal. Behavioral,
real-database, rendered-browser, and build-artifact tests are required at the relevant
boundaries.

Resolution: #72.

### Medium — governing documentation contradicts current decisions

The durable context still describes retired visual patterns, while production-safety
assumptions disagree across closed tickets and runbooks. Future agents can legitimately
follow the wrong authority unless precedence and supersession are explicit.

Relevant source:

- `CONTEXT.md`
- `docs/SPEC_REMAINING_HARDENING.md`

Resolution: #73.

### Medium — closure evidence was incomplete and non-auditable

Many closed tickets used abbreviated logs, omitted exit codes/counts/skips, waived
browser runs, or lacked defect reproduction and criterion-to-evidence traceability.
The project needs immutable run manifests rather than prose claims.

Resolution: #74.

## Remediation issue map

| Issue | Priority | Outcome |
|---|---:|---|
| #55 | Spec | Governing closeout architecture, phases, gates, and shared decisions |
| #56 | P0 | Remove direct patient Realtime; restore least-privilege desk projections |
| #57 | P0 | Enforce `waiting → seen` in doctor assignment |
| #58 | P0 | Cancellation-safe, continuously ready QR sessions |
| #59 | P1 | Retire patient Auth across database and deployed Auth configuration |
| #60 | P1 | Preserve structured errors; retry only transient failures |
| #61 | P1 | Truthful, fuzzy, retryable lost-slip recovery |
| #62 | P1 | Popup-safe Register-and-Print with same-request retry |
| #63 | P1 | Section-local failure/retry and safe error mapping |
| #64 | P1 | Four distinct A4 slips and real print-medium geometry proof |
| #65 | P1 | Durable SMS delivery state and truthful cron outcomes |
| #66 | P1 | Serialize capacity edits with registration |
| #67 | P1 | Serialize duplicate detection without blocking explicit override |
| #68 | P1 | Fail-closed readiness and clean migration replay |
| #69 | P2 | Computed touch, contrast, focus, and 200% text verification |
| #70 | P2 | Atomic queue position using canonical FCFS ordering |
| #71 | P2 | Measured client-island splitting and ratcheted budgets |
| #72 | P2 | Replace source-wiring assertions with behavioral regression seams |
| #73 | P2 | Reconcile architecture, design, and production-safety documentation |
| #74 | P2 | Immutable, complete closure evidence and validation |

## Recommended execution order

1. **Containment:** #56, #57, #58.
2. **Database authority and concurrency:** #59, #66, #67, then #70.
3. **Error/workflow correctness:** #60, then #61, #62, and #63.
4. **Print and messaging:** #64 and #65.
5. **Operational proof:** #68 and #69.
6. **Performance and test truth:** #71, then #72.
7. **Governance closeout:** #73 and #74, followed by a fresh full-project sweep.

Shared database contracts must have a single integrator. In particular, #56/#59/#70
all change patient access authority, while #65/#68 share the final runtime-critical
schema contract. #72 should inventory early but replace tests only after the functional
contracts settle.

## Independent fixed-point corrections

The first independent review of the published issue set found that the findings were
fully owned, but the issue specifications themselves still had execution hazards. The
following corrections were applied before final handoff:

- Open deployment ticket #34 was rewritten to the current no-patient-Auth,
  passwordless-status, strict-lifecycle contract and blocked on every #56–#74 child.
- #62 no longer combines a retained `WindowProxy` with the `noopener` feature. It opens
  a same-origin blank target synchronously, treats `null` as blocked, immediately
  severs a valid child handle's opener, then navigates the retained handle after save.
- Overlapping registration/database migrations now have one integrator and explicit
  order: #56 → #59 → #67 → #65 → #68. This prevents a later
  `CREATE OR REPLACE FUNCTION` from silently restoring an older function body.
- #68's final clean replay waits for every schema/function-authority ticket, including
  lifecycle, concurrency, status position, and SMS.
- #69's final computed audit waits for the UI-changing remediation work, while its
  harness can begin early.
- #73/#74 use staged, non-circular ownership: #74 freezes evidence tooling first; #73
  updates domain/design/deployment authority without editing evidence-owned files; #74
  validates #56–#73 and closes; #34 then runs last using the accepted validator.
- Runtime readiness checks only observable database/catalog facts such as absence of
  `patients` from the Realtime publication. #56/#72 own browser/build proof that the
  shipped client subscription is absent.
- #72 solely owns the test-level selection contract. #73 depends on it and only
  reconciles/links broader governing guidance, preventing parallel documentation drift.
- #68–#74 now state rollback, coverage delta, full verification/E2E gates, blockers,
  and immutable evidence requirements directly rather than relying only on #55.
- The nonexistent generic `security review` skill name was removed from #65.
- #55 received an auditable child checklist and dependency matrix as a comment without
  rewriting the governing specification body.

After these corrections, the independent verifier re-read the affected issues and
returned **PASS**: no material finding was missing, no unsafe duplicate scope or
dependency cycle remained, ownership boundaries were coherent, and the set was
executor-ready.

## Rejected or intentionally non-ticketed concerns

- The selected QR decoder size is not reopened; the earlier ticket explicitly researched
  and accepted that dependency.
- Doctor undo/confirmation is deliberately absent from the accepted operational flow.
- The public status page remaining static until reload is deliberate.
- Local persistence of print preference is deliberate.
- Compact `snp:<uuid>` QR payloads are compatible with the parser and are deliberate.
- `SECURITY DEFINER` functions generally use explicit search paths and restricted grants;
  no generic rewrite was justified.
- Service-role use remains server-only in reviewed paths.
- A theoretical cron-secret timing distinction did not justify a ticket without a
  practical exploit path.
- Anonymous camp discovery is an intentional public-registration prerequisite.

## External technical basis

- Supabase Postgres Changes requires row visibility under `SELECT`/RLS; it is not a
  substitute for a least-privilege projection:
  https://supabase.com/docs/guides/realtime/postgres-changes
- PostgreSQL/Supabase row-level security restricts rows, while column privileges are a
  separate control:
  https://supabase.com/docs/guides/database/postgres/row-level-security
  and https://supabase.com/docs/guides/database/postgres/column-level-security
- Retry classification should preserve structured database/PostgREST identity:
  https://supabase.com/docs/guides/api/rest/postgrest-error-codes
  and https://www.postgresql.org/docs/current/errcodes-appendix.html

## Completion definition for this audit

The audit is complete when:

- every reproduced or evidence-supported material finding has an executor-ready ticket;
- ticket decisions are mutually consistent and dependencies are explicit;
- P0 containment precedes architectural cleanup;
- tickets require the verification level appropriate to the defect;
- no ticket authorizes production mutation implicitly;
- the source tree is unchanged;
- an independent fixed-point pass finds no unowned material finding.
