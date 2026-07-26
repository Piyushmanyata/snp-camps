# #71 — Prove and fix actual client-island route splitting

**Branch:** `fix/gate-a-56-57-58`  
**Base tip (pre-#71):** `4f4f0d7` (a11y #69)  
**Date:** 2026-07-26  
**Measure mode:** production `next build` (Turbopack) artifacts + eager/async graph classification

## Problem (false confidence)

Server-Component `next/dynamic()` wrappers still listed client islands in the page
client-reference manifest. Presence of `dynamic()` in source was treated as proof
of deferral, while the budget gate summed **full transitive** chunks (including
async edges) as “first load” (~450 kB gzip for desk routes). Optional code could
be misclassified either as deferred when it was not, or counted as first-load when
it was already async.

## Settled architecture (implemented)

| Island | Boundary | When transferred |
|---|---|---|
| Scanner UI shell (`QrScanner`) | **Client** `next/dynamic` via `qr-scanner-lazy.tsx` | Separate async chunk after desk page mounts (primary Open camera / lookup stay available) |
| Camera decoder (`jsqr`) | `import("jsqr")` inside `QrScanner.start()` only when native BarcodeDetector unavailable | Separate async chunk on **Open camera** (before getUserMedia) |
| Admin Test SMS / Change password | Client lazy sections open-on-`<details>` (`admin-optional-lazy.tsx`) | Chunk requested only when collapsible opened |
| Print QR (`qrcode.react`) | Static import on print client island only | Eager on `/print/*` only; **absent** from desk/status routes |
| Primary desk controls (queue, seat board, check-in, staff, register form) | Static client imports from Server pages | Eager — must be immediately usable |

Misleading Server-Component `dynamic()` wrappers removed from routes that do not
create a real browser split.

## Before (pre-#71 measurement contract)

| Route | Old budget (full transitive gzip) | Notes |
|---|---:|---|
| `/volunteer` | 464000 | Summed async edges into first-load |
| `/doctor` | 461000 | Same |
| `/admin` | 462000 | Same |
| `/register` | 410000 | Same |
| Marker gate | none | No eager-vs-async optional dependency check |

At tip `4f4f0d7`, scanner was wrapped with Server `dynamic()` — **not** a proven
browser split. jsqr already used `import()` (real async) but was not asserted.

## After (measured eager initial vs deferred async)

| Route | Initial gzip | Deferred gzip | Budget (ratcheted) | Headroom | Deferred markers |
|---|---:|---:|---:|---:|---|
| `/` | 202190 | 0 | 209000 | ~3% | — |
| `/login` | 266976 | 0 | 273000 | ~2% | — |
| `/register` | 405612 | 0 | 410000 | ~1% | no jsqr / qrcode |
| `/volunteer` | 405547 | 53209 | 418000 | ~3% | `scanner_ui`, `jsqr_lib` |
| `/doctor` | 399142 | 54776 | 412000 | ~3% | `scanner_ui`, `jsqr_lib` |
| `/admin` | 405989 | 55010 | 419000 | ~3% | `scanner_ui`, `jsqr_lib`, SMS/password islands |
| `/admin/patients` | 396243 | 0 | 406000 | ~2% | — |
| `/print/[id]` | 209597 | 0 | 212000 | ~1% | `qrcode_react` (eager; page purpose) |
| `/print/batch` | 210266 | 0 | 217000 | ~3% | `qrcode_react` (eager) |
| `/p/[id]`, `/s/[token]` | 193126 | 0 | 199000 | ~3% | no optional heavy islands |
| `/_not-found` | 193126 | 0 | 199000 | ~3% | — |
| `/_global-error` | 186999 | 0 | 193000 | ~3% | — |

Framework shared (`rootMainFiles`+polyfills) ≈ **178711** gzip on every route;
app-only eager is initial − framework.

### Chunk ownership proof (this build)

| Chunk (content-hash name varies per build) | Role | Routes |
|---|---|---|
| `*39fgiytt47ohq*` (~47 kB gzip) | `jsqr_lib` (`BitMatrix`+`VERSIONS`) | deferred on `/volunteer`, `/doctor`, `/admin` only |
| `*2y9y7ad8q7kzm*` / `*3g11bji2yk_fo*` | `scanner_ui` shell | deferred desk routes |
| `*1p4lahote9vxf*` | Admin Test SMS | deferred `/admin` only |
| `*08y5vmff5h0ta*` | `qrcode_react` | eager `/print/[id]`, `/print/batch` only |

**Async edges:** scanner shells reference jsqr via Turbopack `Promise.all([…]).map(…e.l)` — classified as deferred, not eager.

## Budget checker changes

`scripts/check-js-budget.mjs`:

1. Classifies chunk graph edges as **sync** vs **async** (Turbopack `Promise.all` load factories).
2. Budgets apply to **eager/initial** only (sync closure from page entries + shared root).
3. Reports deferred size separately; writes `.scratch/remediation-71/route-chunk-map.json`.
4. `checkEagerMarkers` fails if optional markers appear in initial chunks.
5. Minified jsqr markers: `BitMatrix`+`VERSIONS`, decimal `40018`/`40019`, plus unminified forms.

Budgets ratcheted **down** where headroom was large; never raised above prior ceilings
for the same measure. Routes with already-tight ceilings kept.

## Browser / E2E

- `e2e/island-split.spec.ts` — production server only (`E2E_PRODUCTION=1`).
- Asserts desk initial markers lack `jsqr_lib` / `qrcode_react`.
- Asserts critical controls visible before optional decoder.
- Forces no `BarcodeDetector`; clicks Open camera; expects jsqr chunk request after.
- `playwright.config.ts` + `e2e/run-local.mjs` default to `next start` (build if missing).

## Diff review — client boundaries (minimal)

| File | Why |
|---|---|
| `src/components/qr-scanner-lazy.tsx` | **New** client loader; only place `dynamic(QrScanner)` lives |
| `src/components/admin-optional-lazy.tsx` | **New** client open-on-toggle for non-critical admin panels |
| `src/components/desk-scan-queue.tsx` | Uses `QrScannerLazy`; LiveQueue static (critical) |
| `src/app/{doctor,volunteer,admin}/page.tsx` | Drop server `dynamic()`; static primary controls |
| `src/app/{page,register,print/**,admin/patients}/page.tsx` | Drop misleading server `dynamic()` |
| `scripts/check-js-budget.mjs` | Real artifact measurement + marker gate |
| `js-route-budgets.json` | Ratcheted eager budgets |
| `tests/js-budget.test.mjs` | Marker / classify / CLI failure coverage |
| `e2e/island-split.spec.ts` | Production network/chunk asserts |

No whole-route conversion to client components.

## Acceptance checklist

- [x] Claimed splits visible as distinct production chunks (async graph + markers)
- [x] Optional camera decoder / print QR not in eager desk graphs
- [x] Primary controls remain static/eager on desk routes
- [x] Budgets track browser-loaded eager production client code
- [x] Budgets ≤ prior ceilings; ≈ measured + small headroom
- [x] No broad client rendering of routes solely for splitting
- [x] Evidence replaces import-syntax assertions

## Artifacts

- `.scratch/remediation-71/route-chunk-map.json`
- `.scratch/remediation-71/budget-check.log`
- `.scratch/remediation-71/EVIDENCE.md` (this file)
- Implementer logs (after gates):  
  `C:\Users\piyus\AppData\Local\Temp\grok-goal-a5c888ca8289\implementer\ticket-71-verify.log`  
  `C:\Users\piyus\AppData\Local\Temp\grok-goal-a5c888ca8289\implementer\ticket-71-e2e.log`
