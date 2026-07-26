<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Agent Governance Rules — SNP Camps

## Document Authority Precedence

When governing documentation or instructions conflict, agent decisions MUST resolve according to the following strict hierarchy:

1. **Remediation & Specification Contracts**: Closed/accepted issue remediation specifications (#56 for auth/realtime/least-privilege boundaries, #68 for fail-closed readiness, #72 for test selection contract, #74 for evidence governance contract).
2. **`CONTEXT.md`**: Ubiquitous language, domain context, lifecycle invariants, role boundaries, accepted design-system rules.
3. **`README.md`**: Operations, deployment setup, build/verify gates, auth model reference, MSG91 configuration.
4. **ADRs (`docs/adr/`)**: Architectural decision records (e.g. `0001-passcode-on-desk-slip.md` as superseded historical context).
5. **Historical Spec Files (`docs/UI_UX_OVERHAUL_SPEC.md`, etc.)**: Retained for historical context only; superseded where conflicting with accepted remediation rules (#56, #69, #73).

## Production Safety & Realtime Boundaries (#56)

* **Production Data Safety**: Production contains live medical camp operational data. **Production is NEVER assumed to be empty.** Running `db reset` or re-applying baseline SQL against production is strictly prohibited. Schema changes must use append-only incremental migrations validated via clean replay on disposable databases (#68).
* **Realtime Boundary**: Public patient Realtime channels are retired (#56). The `patients` table is strictly absent from the `supabase_realtime` publication (`patients_realtime_absent` check).
* **Polling**: Queue, seat board, and desk updates use manual Refresh or fixed polling — zero public WebSocket channels on patient rows.
* **Least Privilege & Role Boundaries**: Desk operations operate under strict SQL role functions: `isStaff()` (admin, volunteer) for desk registration/management, `isCampCrew()` (admin, volunteer, doctor) for QR lookup and assignment. Patients do not sign in and hold no Supabase Auth sessions.
* **Status Token Boundary**: Passwordless `/s/<token>` provides public status tracking via the `patient_status_by_token` RPC, returning only non-sensitive queue metrics (sensitive patient PII, phone, address, and Aadhaar details are stripped).

## Visual & Design System Guidance (#69, #73)

* Retired visual guidance (glow typography, glassmorphism, glowing status badges) is removed and superseded by accepted design-system rules in `CONTEXT.md`.
* UI components must enforce high-contrast WCAG 2.2 AA compliance for field legibility under bright outdoor light, tactile press scaling (`scale(0.98)`), clear solid status badges, and `prefers-reduced-motion` compliance.

## Testing & Evidence Governance (#72, #74)

* **Sole Test Selection Contract (#72)**: All test creation and selection must strictly link to **[Issue #72](#72)** as the sole test-level selection contract. Brittle source-text regex assertions are prohibited. Testing relies on empirical runtime behavior across defined seams (`node:test` unit/behavior suite, `tests/*.db.test.mjs`, Playwright role e2e suite, and `npm run verify` full gate).
* **Closure Evidence Governance (#74)**: All ticket completion claims must strictly follow **[Issue #74](#74)** evidence contract. Never declare success without literal `npm run verify` terminal output, DB skip count declarations, e2e summary, coverage delta statement, and empirical red/green failure proof for bug fixes.
