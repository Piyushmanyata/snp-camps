# Full-matrix verification evidence pack

Parent: https://github.com/Piyushmanyata/snp-camps/issues/1  
Children: #2 baseline/auth · #3 scan-to-seen · #4 role e2e · #5 UX/perf · #6 closeout  

Measured on **main** against the configured Supabase project. Date: **2026-07-23**.

## Summary

| Gate | Result |
|------|--------|
| `npm run verify` (lint + unit + build) | **PASS** |
| Unit contracts | **101/101 pass** (incl. deep-link + QR host contracts) |
| Playwright role e2e | **10 passed**, 1 skipped (live SMS OTP) |
| Health liveness `GET /api/health` | **200** `{"ok":true}` |
| Health readiness `GET /api/health?ready=1` | **503** — DB shape OK, `phoneOtp: false` (honest not-ready) |
| Load smoke (local, 10 VUs, 15s) | **0% error**, p95 **35 ms** |
| Desk public routes p95 | under 25 ms (loopback, unauthenticated) |
| `lookup_patient_scan` RPC p95 (n=40) | **~82 ms** (SLO under 500 ms) |
| Anon call to `lookup_patient_scan` | **permission denied** (fail closed) |

## Fixes landed this pass

1. **QR entry host-safe redirects** (`src/app/patient/enter/[id]/route.ts`): redirects clone `req.nextUrl` so staff stay on the same host/port they are already using. Preferring `NEXT_PUBLIC_SITE_URL` bounced local desk sessions to production and dropped auth cookies needed for lookup-first scan.
2. **Deep-link URL clean without remount** (`src/components/qr-scanner.tsx`): after `?scan=` lookup, strip the query with `history.replaceState` instead of `router.replace`, which remounted the scanner and cleared the review card.
3. **E2E matrix extensions**: public QR never logs in; invalid QR help; staff deep-link lookup-first; garbage lookup fails closed. Fixture exports `E2E_PATIENT_ID`.
4. **Unit contracts** for both redirect host safety and deep-link History API behavior.

## Issue acceptance map

### #2 Baseline + auth
- verify green; health recorded; e2e roles pass; p95 baseline recorded; sign-in/out per role; disabled staff blocked in contracts; secrets not in URLs; `getClaims` + profile role; no SQL applied.

### #3 Scan-to-seen
- QR formats unit-tested; non-staff → qr-help (e2e); staff deep-link lookup-first (e2e, fixed); garbage safe; print/seen/already-seen/double-submit via SQL + UI contracts.

### #4 Role journeys
- Admin / volunteer / doctor / patient e2e journeys with disposable Codex E2E fixtures + cleanup.

### #5 UX / a11y / perf
- Existing a11y contracts; poll 2 min or manual; desk + scan SLOs met under measurement; load smoke 0% error.

### #6 Edge closeout
- Seat-full / inactive camp messaging + RPC guards; wrong-role fail closed; evidence in this file.
- **Deferrals**: live SMS OTP (readiness `phoneOtp: false`); physical camera QR timing.
- **Schema**: no migrations proposed or applied.

## Commands

```bash
npm run verify
E2E_BASE_URL=http://localhost:3100 E2E_REUSE_SERVER=1 npm run test:e2e
LOAD_BASE_URL=http://127.0.0.1:3100 LOAD_VUS=10 LOAD_DURATION_SECONDS=15 npm run load:smoke
```
