<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Agent Governance Rules — SNP Camps

## What this app is

A queue tracker for a free eye camp. It moves a patient through
`registered → waiting → seen` and prints a prescription form. **The paper is the
clinical record** — the app stores no diagnosis, medicine, or treatment data, and
should never grow any. Read
[`docs/adr/0008-printing-queues-the-patient.md`](docs/adr/0008-printing-queues-the-patient.md)
before proposing any clinical feature.

The desk has exactly two actions: **Print prescription** (which queues the patient)
and **Mark seen**. If a change adds a third, question it hard.

## Document Authority Precedence

When governing documentation conflicts, resolve in this order:

1. **`docs/adr/`** — architectural decision records. ADR 0008 defines the current architecture; ADRs 0001, 0006 and 0007 are superseded and retained for the reasoning, not the decision.
2. **`CONTEXT.md`** — ubiquitous language, domain context, lifecycle invariants, role boundaries, accepted design-system rules.
3. **`README.md`** — operations, deployment setup, build/verify gates, auth model reference, MSG91 configuration.

## Production Safety

* **Production is NEVER assumed to be empty.** Running `db reset` or re-applying baseline SQL against production is strictly prohibited. Schema changes must use append-only incremental migrations validated via clean replay on a disposable database (`npm run test:db:replay`).
* Migration `20260728119000` dropped the retired clinical tables irreversibly. That was a **one-time, explicitly authorised exception** taken while production held test data only and no real camp had run. It sets no precedent: once real camp data exists, removals must archive rather than drop, and any irreversible migration needs fresh explicit confirmation.
* **Realtime Boundary**: Public patient Realtime channels are retired. The `patients` table is strictly absent from the `supabase_realtime` publication (`patients_realtime_absent` check).
* **Polling**: Queue, seat board, and desk updates use manual Refresh or fixed polling — zero public WebSocket channels on patient rows.
* **Least Privilege**: `is_staff()` (admin, team_lead, volunteer) gates every desk RPC. `is_camp_crew()` is an **alias** of it, not a wider set — the doctor role was retired. Patients do not sign in and hold no Supabase Auth sessions.
* **Status Token Boundary**: `/s/<token>` resolves via `patient_status_by_token`, which is **service-role only** and returns queue metrics with PII, phone, address and Aadhaar details stripped. Do not widen its grants.

## Postgres

* You cannot drop a value from an enum type. `user_role` still lists `doctor` and `patient`; both are non-login and the app treats them as such. Disable residual profiles rather than trying to remove the label.
* Changing a function's **argument list** creates a new overload rather than replacing the old one, and `CREATE OR REPLACE` cannot change a return type at all. When either changes, `DROP` the exact old signature explicitly and re-grant — a dropped-and-recreated function loses its grants, and a forked overload leaves the old one live. Check `pg_proc` afterwards.
* Preserve `FOR UPDATE` lock order and capacity guards when editing an existing RPC. `upsert_camp_day`'s row lock and `SEAT_LIMIT_BELOW_ASSIGNED` check exist to serialize capacity edits against concurrent registrations; rewriting the function without reading it first silently removes that protection.

## Visual & Design System

* UI must meet WCAG 2.2 AA for field legibility under bright outdoor light: high contrast, 44×44 minimum touch targets, visible focus rings, text scaling, tactile press scaling (`scale(0.98)`), clear solid status badges, and `prefers-reduced-motion` compliance.
* Retired visual guidance (glow typography, glassmorphism, glowing status badges) is removed and superseded by the design-system rules in `CONTEXT.md`.
* Patients read Hinglish; staff read English. Leaks in either direction are bugs.

## Testing & Evidence Governance

* Tests assert empirical runtime behaviour across four seams: the `node:test` unit suite, `tests/*.db.test.mjs`, the Playwright role e2e suite, and the full `npm run verify` gate. Brittle source-text regex assertions are discouraged — they break on rename and pass on rot.
* **A skipped database test is a failure, not a pass.** `npm run test:db` fails on any skip and names it a blocker. A test file may skip only when the database is genuinely unreachable. Guards that treat a *missing RPC* as "Postgres unavailable" silently delete coverage exactly when a migration breaks something — this has happened in this repo, and it hid three real failures.
* **A green suite is not evidence the app works.** Every defect found in the July 2026 audit passed the full suite. Verify against a running app.
* Do not claim a suite passed without the terminal output. Report skip counts explicitly. For a bug fix, show the test failing before the fix and passing after.
