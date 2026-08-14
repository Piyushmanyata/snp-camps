# Original User Request

## Initial Request — 2026-08-14T07:06:49Z

Comprehensive codebase review, defect remediation, performance optimization, and rigorous automated verification for the SNP Camps eye camp desk tracker application.

Working directory: c:/Users/piyus/Downloads/snp-camps-main/snp-camps-main
Integrity mode: development

## Requirements

### R1. Deep Codebase Audit & Defect Remediation
Audit the entire application (Next.js App Router, Supabase Postgres migrations/RPCs, role security boundaries, and data mutations) to identify and fix all syntax, type, logic, security, and edge-case errors while maintaining established domain invariants (ADR 0013, ADR 0008, and CONTEXT.md).

### R2. Optimization & Code Quality Hardening
Eliminate dead code, streamline data access paths, optimize database RPC locks and indexing, ensure strict adherence to repo governance (no client Supabase Realtime subscriptions on patients table, strict `is_staff()` gate on desk operations, zero code comments), and harden accessibility and WCAG 2.2 AA standards.

### R3. Database Safety & Incremental Migrations
Ensure all database schema changes adhere to append-only migration policies with clean replayability (`npm run test:db:replay`). Do not drop active tables or alter locked capacity serialization logic.

### R4. Automated Verification Gate
Execute and pass all verification seams: TypeScript typecheck (`tsc --noEmit`), ESLint, Node unit tests, and Supabase database tests with zero skipped tests.

### R5. Staged Git Preparation
Stage verified changes into atomic, descriptive git commits prepared for main branch release.

## Acceptance Criteria

### Automated Verification
- [ ] `npm run verify` (or equivalent typecheck, lint, and test suites) runs completely green with 0 errors and 0 skipped tests.
- [ ] Database migration replay (`npm run test:db:replay`) passes cleanly on a fresh schema.

### Domain & Security Invariants
- [ ] The `patients` table remains strictly absent from the `supabase_realtime` publication.
- [ ] `is_staff()` correctly gates all desk RPCs and status lookups remain least-privilege token-based.
- [ ] Patient desk lifecycle strictly adheres to `registered -> seen` and prescription printing semantics without adding unapproved queue states.
