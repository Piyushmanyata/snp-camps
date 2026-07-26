# #64 Evidence — Batch four distinct A4 slips; prove real print geometry

Date: 2026-07-26  
Branch: `fix/gate-a-56-57-58` (tip after #63 `fd55da0`)  
Issue: [#64](https://github.com/Piyushmanyata/snp-camps/issues/64)

## Defect (red)

1. A4 2×2 sheet **repeated one patient four times** (false “paper saving”).
2. Registration still opened **one sheet per patient** — batch goal of #54 failed.
3. Browser evidence was **screen DOM screenshots**, not print media/PDF.
4. Thermal hard-limited to **fixed 110 mm** + `overflow: hidden` → long names clip silently.
5. Print CSS lived in **global** CSS; interactive routes paid the cost.

## Fix

### Station A4 batch queue — `src/lib/a4-batch-queue.ts`

| Behavior | Detail |
|---|---|
| Storage key | `snp.a4BatchQueue` |
| Payload | `{ v:1, entries:[{ id, addedAt }] }` only — **no** name/phone/Aadhaar/token |
| Bound | Max **4 distinct** UUIDs; never duplicates to fill cells |
| Lifecycle | Survives reload; cleared only via **Start next sheet** (print completion is not knowable) |
| Paths | `/print/batch?ids=…` preview + `auto=1` print |

### Print sheet — `src/components/print-sheet.tsx`

- A4 accepts `slips[]` (0–4 **distinct**); unused cells render empty (`desk-slip-a4-cell--empty`).
- Thermal is one-up only.
- Name/venue use `overflow-wrap` / break-word; QR sizes fixed (scannable floor).
- Documented max fixtures: **120-char name**, **~80-char venue**.

### Routes

| Route | Role |
|---|---|
| `/print/[id]` | One-up (thermal or single A4 with 3 empty cells) |
| `/print/batch` | Multi-up A4; server loads authorized ids; client bootstrap recovers from localStorage when `?ids` missing |
| `src/app/print/layout.tsx` + `print.css` | **Route-scoped** `@page` / `@media print` (removed from `globals.css`) |

### Registration handoff (#62 + #64)

- **Thermal**: pre-open `about:blank` → navigate `/print/{id}?auto=1` (unchanged recovery).
- **A4**: enqueue id; no post-await popup; batch panel + **Print A4 sheet** recovery; at 4, primary Print.

### Thermal geometry

- `@page desk-thermal58 { size: 58mm auto; }` (was `58mm 110mm`).
- Print sheet `overflow: visible` (was `hidden`).

## Acceptance matrix

| Criterion | Result | Evidence |
|---|---|---|
| Four A4 regs → one sheet, four distinct reg/name/QR | Pass | E2E `a4-batch` four sequential + PDF |
| 1–3 patients: empty cells, no duplicates | Pass | E2E partial batch + unit `addToA4Batch` |
| Thermal one patient per print | Pass | E2E thermal immediate + print-passcode |
| Partial flush / reprint / clear / reload recovery | Pass | Start next sheet E2E; batch panel; `/print/batch` bootstrap |
| No PII in station storage | Pass | E2E storage key assert + unit strip |
| Print media/PDF geometry (A4, 2×2, thermal width, QR in bounds) | Pass | `emulateMedia('print')` + `page.pdf()` |
| 120-char name + long venue no clip | Pass | E2E max-length + PDF |
| Reg largest / QR scannable | Pass | Geometry asserts + samples |
| Interactive JS budgets not regressing from print CSS | Pass | `/register` 404k < 410k; print styles under `/print/*` only |
| `npm run verify` | Pass | 339 tests, lint, build, JS budget |
| `npm run test:e2e` | Pass | 26/26 |

## Artifacts

| Path | Content |
|---|---|
| `.scratch/remediation-64/a4-four-distinct.pdf` | Four distinct A4 slips (print PDF) |
| `.scratch/remediation-64/a4-max-content.pdf` | Max-length name fixture |
| `.scratch/remediation-64/a4-single-print-media.pdf` | Single + empty cells |
| `.scratch/remediation-64/thermal-print-media.pdf` | 58mm thermal |
| `docs/desk-slip-samples/a4-multi-up.png` | Regenerated sample |
| `docs/desk-slip-samples/thermal-58mm.png` | Regenerated sample |
| `.scratch/remediation-64/ticket-64-verify.log` | Full verify |
| `.scratch/remediation-64/ticket-64-e2e.log` | Full e2e |

## Gates

| Gate | Result |
|---|---|
| `npm run verify` | **Pass** (339 unit tests, lint, build, JS budget) |
| `npm run test:e2e` | **Pass** 26/26 |
| Readiness contract | Unchanged (no schema) |

## JS budgets (measured gzip)

| Route | Actual | Budget |
|---|---:|---:|
| `/print/[id]` | 209975 | 212000 |
| `/print/batch` | 210226 | **217000** (new, measured) |
| `/register` | 404879 | 410000 |
| Interactive desks | unchanged within prior budgets | |

## Rollback

- Thermal one-up remains the safe path (`snp.deskSlipFormat=thermal58`).
- If A4 batching must be disabled: keep queued ids + one-up `/print/{id}` links; **never** restore four identical copies as “paper saving”.

## Commit

`fix(print): batch four distinct A4 slips; prove geometry (#64)`
