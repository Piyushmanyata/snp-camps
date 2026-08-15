# Project: SNP Camps Desk Tracker — Comprehensive Audit, Remediation & Hardening

## Architecture
- **Framework**: Next.js 16 App Router with React Server Components and React 19 Client Components.
- **Database & Auth**: Supabase PostgreSQL with Row Level Security (RLS) enabled on all 15 tables, 41 `SECURITY DEFINER` RPCs, and service-role locked operations.
- **Security & Lifecycle**: Strictly `registered → seen` lifecycle (ADR 0013), presence recorded idempotently via `printed_at`, 2 desk actions (Print prescription & Mark seen, ADR 0008), zero realtime subscriptions on patients (`patients` table absent from `supabase_realtime`).
- **Verification Gates**: TypeScript (`tsc --noEmit`), ESLint (`eslint.config.mjs`), Unit Suite (458 unit & empirical tests via `node:test`, zero skips permitted), DB Integration Suite (30 `.db.test.mjs` suites, zero skips permitted), JS Budget (`scripts/check-js-budget.mjs`), Env Drift (`scripts/check-env.mjs`), Migration Heads (`scripts/compare-migration-heads.mjs`), Full Composite (`npm run verify`).

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---|---|---|---|
| 1 | DB Test Harness Zero-Skip Enforcement | Eliminate `to_regprocedure` in `connect()` across 14 DB test files so schema/RPC breakage fails loudly | M1 | Survey (explorer_db_1) |
| 2 | Migration Replay & Catalog Verification | Verify append-only migration chain up to head `20260813090000` via clean replay | M1 | Survey (explorer_db_1) |
| 3 | Per-Section Error Resiliency in Server Pages | Replace unhandled page-level throws in `admin/clinical-operators`, `volunteer`, `team-lead` with per-section retry cards | M2 | Survey (explorer_app_1) |
| 4 | Admin QR Scan Route Correction | Correct `/p/[id]` routing so admins scanning patient QR are directed to registration/admin desk rather than `/clinical` | M2 | Survey (explorer_app_1) |
| 5 | Clean Retired CSS Queue Selectors | Remove residual `#queue` CSS rules in `src/app/globals.css` post ADR 0013 queue removal | M2 | Survey (explorer_app_1) |
| 6 | AGENTS.md §8 Zero Comments Rule Compliance | Strip non-workaround comments across `src/` to satisfy repository coding standards | M3 | Survey (explorer_app_1) |
| 7 | Dead Code & Code Quality Hardening | Optimize data access, enforce strict typing, ensure zero lint warnings and zero dead code | M3 | Survey (explorer_app_1, explorer_tests_1) |
| 8 | Multi-Seam Verification & Gate Execution | Run TypeScript check, ESLint, Node unit tests (469 tests), live DB tests (0 skips), and full verify gate | M4 | Survey (explorer_tests_1) |
| 9 | Adversarial Hardening & Forensic Audit | Run 2 adversarial reviewers, 2 challengers, and 1 forensic auditor across all changes | M4 | Project Pattern |
| 10 | Atomic Git Release Staging | Prepare clean, atomic commit structure for main branch release | M4 | ORIGINAL_REQUEST |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|---|---|---|---|
| 1 | DB Test Harness Hardening | Standardize 14+ `.db.test.mjs` test connection handlers to reachability-only, eliminate silent skips | none | DONE |
| 2 | App Router Resiliency & Routing Remediation | Fix page-level throws in Server Components, fix admin QR scan routing, clean residual queue CSS | M1 | DONE |
| 3 | Code Hardening & Style Compliance | Enforce AGENTS.md §8 zero-comments rule, eliminate dead code, verify types and lint | M2 | DONE |
| 4 | Comprehensive Verification, Audit & Release Staging | Pass full verification gate (`npm run verify`), adversarial review, forensic audit, stage atomic commits | M3 | DONE |

## Interface Contracts
### Database Test Harness
- Any connect helper in `tests/*.db.test.mjs` — whatever it is named (`connect`, `connectDb`, …) — MUST ONLY test database reachability (`await client.connect()`). It MUST NOT probe `to_regprocedure` to avoid suppressing test failures when RPCs are missing or altered.
- A test that needs Postgres MUST live in a `tests/*.db.test.mjs` file. Both `scripts/run-unit-tests.mjs` and `scripts/run-db-tests.mjs` fail on any skip, so a DB test misfiled into the unit suite reports itself instead of passing silently ([ADR 0018](docs/adr/0018-the-unit-suite-is-db-free-and-skip-free.md)).

### Client Bundle Boundary
- A module reachable from a Client Component MUST NOT import a Node built-in. `node:crypto` and friends belong in a sibling module opening with `import "server-only"` ([ADR 0017](docs/adr/0017-server-only-crypto-stays-out-of-shared-modules.md)). `npm run check:js-budget` is the empirical guard.

### Server Component Resilience
- Server Component pages (`src/app/admin/clinical-operators/page.tsx`, `src/app/volunteer/page.tsx`, `src/app/team-lead/page.tsx`) MUST catch query errors locally and render per-section fallback/retry UI components rather than throwing unhandled `Error`s.

### Patient QR Scan Route (`/p/[id]`)
- Role dispatch logic in `src/app/p/[id]/page.tsx` MUST route `isAdmin(role)` to the admin/volunteer registration desk context (`/admin/patients?scan=...` or `/volunteer?scan=...`), reserving `/clinical?scan=...` strictly for `isClinicalOperator(role)`.

## Code Layout
- `src/app/` — Next.js App Router pages, layouts, error boundaries, API route handlers
- `src/components/` — React Server & Client Components
- `src/lib/` — Domain helpers, Supabase clients, readiness contracts, validation schemas
- `supabase/migrations/` — Append-only SQL migrations
- `tests/` — Node.js test runner unit suites and Supabase integration `.db.test.mjs` suites
- `scripts/` — Verification gate runners, evidence capture, JS budget calculators
