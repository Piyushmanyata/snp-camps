# Adversarial Audit Plan — 2026-07-26

## Project Completion Goal

Deliver an evidence-backed adversarial review of the current `main` branch and the closed-ticket wave for the SNP Camps operator by producing:

1. a repository and history review that identifies what changed, why it changed, and where the new approach conflicts with code, tests, migrations, documentation, or prior ticket decisions;
2. reproducible evidence for every material defect or compliance gap;
3. one researched specification that fixes the confirmed problem set without reopening superseded product decisions; and
4. verbose, independently executable GitHub tickets with explicit blocking edges, relevant skills, acceptance criteria, verification commands, rollback notes, and prohibited wrong turns.

The audit is complete only when the current baseline has been measured, all closed issues and their implementation commits have been traced at a useful level, the critical paths have been reviewed across code/data/security/UX/accessibility/performance/testing, unsupported findings have been discarded, an independent reviewer has challenged the final findings and tickets, and every published claim links to source, history, test, browser, database, or ticket evidence.

## Shared Understanding

- The current product authority is the v6 two-round model in `README.md` and `CONTEXT.md`: desk-only registration, future pre-registration in `registered`, camp-day/walk-in or explicit check-in in `waiting`, one-way `seen`, staff-scan QR, and passwordless patient status.
- Superseded patient passcode/OTP-login and Supabase Realtime approaches are historical context, not desired functionality.
- The review covers the whole repository and closed issues #1–#54, with deeper ticket-fidelity review on the dense implementation wave #15–#54.
- Decisions are delegated to the auditor. The normal skill pauses for interviewing and ticket-granularity approval are intentionally skipped under the user's explicit instruction.
- Findings must be defects, unfulfilled ticket requirements, false/insufficient closure evidence, dangerous ambiguity, or demonstrable maintainability/operability risks. Preference differences and speculative cleanup are excluded.
- The repository is not to be fixed in this task. Only audit artifacts and remediation issues may be created.

## Acceptance Criteria

- Baseline results are recorded for lint, unit/contract tests, production build, JavaScript budget, database tests where safely runnable, and Playwright E2E or an exact environment blocker.
- Closed issues are mapped to commits and current implementation; closing comments are checked against the repository's definition of done.
- Current code is reviewed for authentication/authorization, service-role isolation, RLS/RPC grants, migrations, queue invariants, concurrency/idempotency, retries, SMS billing/idempotency, cron authorization/timezone behavior, QR/camera teardown, status-token privacy, error handling, React/Next performance, accessibility, print behavior, documentation truth, and test sensitivity.
- Material candidate findings are reproduced or proven with a red-capable command whenever feasible.
- Each confirmed finding has severity, user impact, root cause, evidence, affected decisions/tickets, correct remediation direction, test seam, rollback, and duplicate/supersession analysis.
- A fresh independent review verifies the audit and issue set before publication.
- Every GitHub remediation issue is labeled `ready-for-agent` and contains the skills the executor must use.

## Non-Goals

- Reintroducing patient authentication, passcodes, public self-registration, or Supabase Realtime.
- Applying migrations, changing production data, deploying, or fixing the implementation.
- Aesthetic redesign without measurable field-use or accessibility impact.
- Creating tickets for hypothetical scale problems without evidence.
- Reopening parent issues or altering closed issues.

## Capability and Ownership

- Mode: `concurrent`.
- The harness supports three concurrent child agents in addition to the primary agent, result collection, interruption, and follow-up.
- Child agents are read-only. They must not edit files, create issues, or change external state.
- The primary agent owns all local audit artifacts, integrated verification, deduplication, specifications, and GitHub issue creation.

## Skill Manifest

| Skill | Purpose | Invocation |
|---|---|---|
| `grill-with-docs` + `grilling` + `domain-modeling` | Stress-test current decisions against tickets, glossary, ADR, code, and concrete edge cases | Reconnaissance and finding validation |
| `ponytail` (full) | Reject speculative cleanup; require the smallest root-cause remediation at the highest shared seam | Every finding and ticket |
| `to-spec` | Synthesize confirmed findings into researched implementation decisions and test seams | After finding validation |
| `to-tickets` | Produce vertical, context-sized tickets with blocking edges | After spec review |
| `graphify` | Build/query a structural map before broad traversal and identify hidden coupling | Reconnaissance and impact analysis |
| `code-review` | Keep repository-standards and ticket-spec fidelity as separate review axes | Historical/ticket review |
| `supabase` + `nextjs-supabase-auth` | Review current auth/session, service-role, RLS/RPC, and Supabase integration risks | Security/data batch |
| `supabase-postgres-best-practices` | Review query, index, concurrency, locking, and migration decisions | Database batch |
| `vercel-react-best-practices` | Review waterfalls, bundle boundaries, server/client data, re-renders, and mutable request state | Frontend/performance batch |
| `accessibility` | WCAG 2.2 static and browser review of operational desks | UI/browser batch |
| `webapp-testing` | Browser evidence, console/network inspection, keyboard and responsive journeys | UI/browser batch |
| `diagnosing-bugs` | Require tight red-capable loops for material defects | Candidate validation |
| `codebase-design` | Evaluate seams, locality, and shallow modules without prescribing speculative refactors | Architecture batch |
| `tdd` | Define behavioral regression tests at existing high seams for every remediation ticket | Ticket design |
| `check-work` | Independent final verification of audit completeness and ticket executability | Final gate |

Third-party skills discovered through `skills.sh` are not installed: the already installed official/project skills are more trusted and non-duplicative.

## Context Strategy

- Ponytail: no ticket without evidence and user impact; prefer deletion/retirement of obsolete paths and fixes at shared seams.
- LeanCTX: compressed shell/build/history output and focused source retrieval. Degraded note: the referenced local policy file is missing and the LeanCTX allowlist blocks Graphify, so Graphify runs directly.
- Graphify: deep map of code/docs/images. SQL extraction must be either enabled with the official extra or the SQL scope mapped directly and the limitation recorded.

## Budget

```yaml
budget:
  max_cost: null
  max_incremental_tokens: 180000
  max_high_capability_model_calls: 8
  max_subagent_sessions: 8
  max_concurrent_subagents: 3
  max_skill_installs: 1
  max_retry_cycles_per_batch: 2
  reserve_percent_for_verification: 25
```

When exact token accounting is unavailable, sessions, broad source reads, retries, and external queries are the accounting proxy.

## Phases and Batches

### Phase 1 — Evidence Baseline and Historical Map

- Batch 1A: Graphify map, repository architecture, domain authority, git/ticket/commit timeline.
- Batch 1B: `npm run verify`, database-test feasibility, E2E, build artifacts, dependency/security diagnostics.
- Exit: baseline and fixed historical review range recorded.
- Rollback: generated graph/build/test output is disposable; no product code changes.

### Phase 2 — Independent Adversarial Reviews

- Batch 2A: ticket fidelity, closure evidence, stale/superseded assumptions.
- Batch 2B: Supabase/Postgres/auth/RLS/RPC/migrations/concurrency/privacy.
- Batch 2C: role workflows, React/Next, scanner/print/SMS/polling, accessibility, visual/browser.
- Primary agent: cross-cutting architecture, static analysis, test sensitivity, dependency and configuration audit.
- Exit: candidate findings include exact evidence and falsification notes.

### Phase 3 — Reproduction and Deduplication

- Build the fastest red-capable loop for each material candidate.
- Discard false positives, duplicates, already-open work, deliberate accepted risks, and findings invalidated by current product authority.
- Exit: confirmed finding register with severity and root cause.

### Phase 4 — Specification and Tickets

- Synthesize one parent specification using current domain vocabulary and existing test seams.
- Split remediation into narrow vertical tickets; wide mechanical changes use expand–migrate–contract only if truly necessary.
- Include explicit decisions, rejected alternatives, blockers, relevant skills, commands, evidence, rollback, and do-not-do guidance.
- Exit: internally reviewed issue bodies ready for publication.

### Phase 5 — Independent Final Gate and Publication

- Independent `check-work` reviewer challenges coverage, evidence, severity, duplicates, blocking edges, and executor ambiguity.
- Rework until pass.
- Publish the spec and remediation tickets to GitHub with `ready-for-agent`.
- Re-read published issues to verify body/labels/edges and produce requirements traceability.

## Highest-Risk Pre-Mortem

Assume the audit failed. The most likely causes are:

1. **Stale authority:** treating a superseded issue as current product intent. Prevention: every finding cites current README/glossary/ADR/spec precedence.
2. **Green-but-insensitive tests:** accepting source-text or tautological contracts as behavioral proof. Prevention: mutation/red-capability checks for material findings.
3. **Migration illusion:** reading only the final baseline or only incrementals. Prevention: replay order and fresh-database behavior are reviewed together; production is never touched.
4. **Historical overreach:** making the ticket set a refactor wishlist. Prevention: Ponytail evidence gate and explicit user impact/root cause.
5. **Ticket duplication:** reopening work already covered by open #34/#36/#41 or an existing closed decision. Prevention: search open/closed tracker before each issue.
6. **Browser blind spot:** passing builds while operational desks remain unusable. Prevention: browser/keyboard/responsive checks and screenshot/console/network evidence.
7. **False closure evidence:** trusting comments copied from an earlier run. Prevention: compare timestamps, literal outputs, current HEAD, and the README closing contract.

## Completion Evidence

- `REVIEW.md`: repository brief, baseline, history/new-approach analysis, confirmed findings, rejected candidates, risk register, and traceability.
- GitHub issue #55: researched remediation decisions, shared gates, and test seams.
- GitHub issues #56–#74: exact, durable executor specifications with skills and evidence requirements.
- GitHub issue #34: corrected current-state final verification/physical-device/deploy gate.
- GitHub URLs, labels, parent backlinks, and the #55 dependency-matrix comment.
- Independent verifier verdict and commands/results.
