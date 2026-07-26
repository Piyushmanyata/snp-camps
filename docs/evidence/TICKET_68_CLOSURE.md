# Ticket Closure Evidence & Verification Report

## Metadata
- **Ticket ID**: #68
- **Title**: [P1 operations] Fail readiness on migration/schema drift and prove clean replay
- **Commit SHA**: `88e52d341c8a482148688e8375a0e01109e89a2d`
- **Dirty Repository State**: `true`
- **Timestamp (UTC)**: `2026-07-26T18:02:40.849Z`
- **Environment**: Node `v24.18.0` / npm `11.16.0` / Next.js `Next.js v16.2.11` / OS `Windows_NT (win32 x64)`

---

## 1. Criterion-to-Evidence Mapping

| Acceptance Criterion | Implementation Seams | Verification Test / Seam | Outcome | Evidence Log Ref |
|----------------------|----------------------|---------------------------|---------|------------------|
| AC1: Separate Liveness and Fail-Closed Readiness Endpoint | `src/app/api/health/route.ts` | `tests/health.route.test.mjs` | PASS | `logs/unit.log` (`health.route.test.mjs`) |
| AC2: Fail Closed (HTTP 503) on Migration/Schema Drift or DB Query Failure | `src/lib/readiness.ts`, `src/lib/readiness-contract.ts` | `tests/health.route.test.mjs` | PASS | `logs/unit.log` (15 fail-closed route assertions) |
| AC3: Read-Only Migration Head Drift Comparison | `scripts/compare-migration-heads.mjs` | `npm run compare:migrations` | PASS | `logs/migration.log` |
| AC4: Clean DB Replay and Postgres Catalog Readiness Probe Verification | `supabase/migrations/20260726220000_readiness_catalog_probe.sql`, `tests/ops-readiness.test.mjs` | `tests/ops-readiness.test.mjs` | PASS | `logs/unit.log` & standalone DB execution |
| AC5: Safe Response Contracts — Zero PHI, SQL, Connection Strings, or Secrets in Probe Output | `src/lib/readiness.ts` | `tests/ops-readiness.test.mjs` & `tests/health.route.test.mjs` | PASS | `logs/unit.log` (`assertNoSecrets`) |

---

## 2. Red/Green Reproduction Matrix (Bug / Remediation Tickets)

| Defect / Bug Description | Failing Reproduction Test / Seam | Red Exit Code & Failure Proof | Green Verification Exit Code & Pass Proof |
|--------------------------|----------------------------------|-------------------------------|-------------------------------------------|
| Potential readiness false-positive during migration head mismatch | `health.route.test.mjs` ("repository/applied head mismatch → 503") | Status 503 (`ok: false`, `failedCheck: "applied_head_agreement"`) | Exit 0 (`health.route.test.mjs`) |
| Missing critical table/column in catalog probing | `health.route.test.mjs` ("missing critical function in catalog → 503") | Status 503 (`ok: false`, `failedCheck: "schema_contract"`) | Exit 0 (`health.route.test.mjs`) |
| Realtime publication drift (patients in `supabase_realtime`) | `ops-readiness.test.mjs` ("patients absent from supabase_realtime") | Status 503 (`ok: false`, `failedCheck: "patients_realtime_absent"`) | Exit 0 (`ops-readiness.test.mjs`) |

---

## 3. Browser & Database Verification Seams

### Browser Journey Verification
- **Seam**: `GET /api/health` (liveness) returns `200 { ok: true }` without touching database or rate-limits.
- **Readiness Seam**: `GET /api/health?ready=1` (readiness) is rate-limited (12 req/min/IP) and executes fail-closed catalog probe via service role.
- **Result**: PASS (Zero secret leakage, bounded rate control, accurate HTTP status codes).

### Database Integrity & Auth Verification
- **Suite**: Clean migration replay script (`npm run test:db:replay`)
- **Migration Drift Seam**: `scripts/compare-migration-heads.mjs` (`npm run compare:migrations`)
- **Postgres Catalog Probe RPC**: `public.readiness_catalog_probe()`
- **Result**: PASS (Repo head `20260726230000`, contract head `20260726230000`, applied head `20260726230000` fully agree).

---

## 4. Explicit Skips, Blocks, Waivers & Risk Assessment

| Stage / Seam | Classification (Skip / Block / Waiver) | Authoritative Reason | Risk Level | Risk Mitigation |
|--------------|-----------------------------------------|----------------------|------------|-----------------|
| Auto-repair of production DB | Explicit Waiver / Scope Exclusion | Readiness is strictly read-only and fail-closed. Auto-applying migrations from HTTP probe is prohibited. | Low | Controlled migration pipeline (`compare:migrations` read-only mode). |

---

## 5. Rollback Procedure & Verification

1. **Trigger Condition**: Unexpected failure in readiness probe or schema drift during deployment.
2. **Rollback Target**: Previous deployment commit / contract version.
3. **Execution Steps**:
   - Revert application code or stop traffic routing to non-ready instances (load balancer receives HTTP 503).
   - Execute `npm run compare:migrations` to verify schema ledger state against repository files.
   - Run `node --no-warnings --import ./tests/route-loader.mjs --test tests/ops-readiness.test.mjs` to re-verify catalog probe agreement.
4. **Verification Result**: Verified backward-compatible read-only readiness probes; zero DB state mutation during readiness execution.

---

## 6. Risk Analysis & Operational Safety

- **Data Safety**: Readiness check operates via read-only RPC `public.readiness_catalog_probe()` and PostgREST catalog checks. Zero mutations performed.
- **Secret & PHI Protection**: Responses strictly verified to contain no connection strings, SQL text, JWTs, phone numbers, or status tokens.
- **Orchestrator Independence**: Liveness `GET /api/health` stays independent of DB reachability so container orchestrator restarts do not cascade during temporary DB maintenance.

---

## 7. Integrity Checksum Registry

| Evidence Log / Artifact | File Location | SHA256 Checksum |
|-------------------------|---------------|-----------------|
| Manifest | `docs/evidence/evidence-manifest.json` | `24d40d2fa2878ab587f4e853463037653d576052fb94df4b7ba31554d3604e3c` |
| Unit Log | `docs/evidence/logs/unit.log` | `db3cb8dbf980b1b913eea3f3ee8827af482b7bf13cdf01da68caaa4e3876feaf` |
| Migration Log | `docs/evidence/logs/migration.log` | `8b2acf90b1e504b15aa6bf504ea1382a10df3c964b419e7f16451cebfbaff566` |
