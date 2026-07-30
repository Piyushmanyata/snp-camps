# Role, Sponsor, and Aadhaar Reliability Plan

## Goal

Ship independently managed Clinical Desk accounts, persistent multi-sponsor
templates, and fast extraction-only Aadhaar capture across low-end phones and
USB keyboard-wedge scanners, then verify and deploy the result to production.

## Decisions

- Aadhaar remains extraction-only and `SELF_DECLARED`; no signature or identity
  verification claim is introduced.
- Clinical Desk Operators retain their existing least-privilege role and shared
  account API, but move out of Team Lead management into an admin-only desk.
- Sponsor order remains the template's `sponsorLogos` array, capped at eight.
- Native full-resolution still capture is the primary phone path. Live video is
  an explicit fallback, not the recommended path.
- Raw QR payloads remain transient in the browser/worker and are never logged or
  persisted. A database audit row records consent, method, outcome, and last-4.

## Batches

1. Move Clinical Desk account management and fix sponsor normalization. Add
   route/resolver regressions and verify focused tests.
2. Add consent-gated native still capture, worker-based USB parsing, actionable
   malformed-payload errors, and extraction audit storage. Verify parser,
   scanner, registration, database, accessibility, and JS-budget seams.
3. Run clean migration replay and the full `npm run verify` gate; review the
   diff for role, privacy, and rollback hazards.
4. Apply the append-only migration to Supabase, run security/performance
   advisors, commit and push `main`, then verify the Vercel production
   deployment and health.

## Acceptance

- Team Lead management contains no Clinical Desk Operator roster.
- Admin has a separate Clinical Desk Accounts route with create, reset,
  deactivate, and reactivate behavior.
- Adding and publishing sponsors preserves the original and subsequent ordered
  logos after reload.
- Phone capture offers native full-resolution still capture first and preserves
  gallery/live fallbacks.
- USB scanner payload parsing runs in the existing worker and clears transient
  input immediately.
- Extraction cannot start without explicit consent; stored audit data contains
  no full Aadhaar number or raw artifact.
- UI and data continue to say scanned/self-declared, never verified.
- Focused tests, clean database replay, full verification, production migration,
  GitHub push, and Vercel deployment all succeed with evidence.

## Rollback

Application changes are reverted by the deployment's prior commit. The database
migration is additive: leave the audit table in place if rolling back the app;
it has no write dependency from older application versions.
