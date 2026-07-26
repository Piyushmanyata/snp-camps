# Ticket #34 Pre-Deployment Handoff & Validation Procedure

## Overview
Ticket #34 owns the pre-deployment verification run for release cut. Under the governance contract established in Ticket #74, Ticket #34 MUST execute the accepted evidence capture tool and pass manifest validation prior to any deployment into staging or production.

---

## Pre-Deployment Verification Protocol

### Step 1: Execute Full Evidence Capture
Run the evidence capture tool across all mandatory verification stages:

```bash
npm run capture:evidence -- --ticket=34
```

This command will:
1. Capture git commit SHA, dirty status, timestamp, platform, and tool versions.
2. Execute all required stages: `lint`, `unit`, `type_build`, `budgets`, `db`, `e2e`, `accessibility`, `migration`, and `env_security`.
3. Apply secret and PHI redaction to all log outputs.
4. Calculate SHA256 checksums for all log files and generate `docs/evidence/evidence-manifest.json`.

### Step 2: Validate Manifest & Integrity
Run the evidence validator to verify evidence completeness and integrity:

```bash
npm run validate:evidence
```

The validator will assert:
- `commit_sha` is valid and clean (or has an explicit waiver).
- All 9 required stages executed with `exit_code: 0` and `status: "PASS"`.
- SHA256 digests of all log files match recorded manifest digests.
- No un-redacted secrets (JWTs, Supabase keys, DB passwords, Aadhaar numbers) exist in logs.
- No handwritten summary placeholders or bare ellipses (`...`) exist in logs.

### Step 3: Publish Closure Evidence
Copy/attach the validated `evidence-manifest.json` and `evidence-report.md` to Ticket #34's GitHub issue before approving the production deployment PR.

---

## Failure & Escalation Criteria
If `npm run validate:evidence` exits with a non-zero status code:
- **Deployment Gate**: DEPLOYMENT IS BLOCKED.
- **Remediation**: Fix the failing stage or defect, re-run `npm run capture:evidence`, and re-validate.
- **Waivers**: Any deferred test or stage MUST be documented with explicit risk classification in `TICKET_CLOSURE_TEMPLATE.md`.
