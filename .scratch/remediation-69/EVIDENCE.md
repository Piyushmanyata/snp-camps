# #69 Evidence — Computed touch, contrast, focus, and text scaling

Date: 2026-07-26  
Branch: `fix/gate-a-56-57-58` (tip after #64 `8daccad`)  
Issue: [#69](https://github.com/Piyushmanyata/snp-camps/issues/69)

## Defect (red — adversarial + source audit)

| Class | Before (computed / source) | Location |
|---|---|---|
| Touch target | Seat Board **Refresh** `min-h-8` (~32px) | `seat-board.tsx` |
| Touch target | Desk freshness **Try again** `min-h-10` (~40px) | `desk-freshness-indicator.tsx` |
| Touch target | Admin patient filters `min-h-9`; staff actions `min-h-11`; camps Set active/Delete no min-h | admin-* |
| Contrast | Scanner success meta `text-brand/80` on brand-soft ≈ **3.38:1** | `qr-scanner.tsx` |
| Contrast | Seen warning body `text-amber-900/80` | `qr-scanner.tsx` |
| Proof gap | Source class/token tests only (`tests/a11y-field.test.mjs`) | no browser matrix |

## Fix

### Touch (≥48×48 CSS px)

- Seat Board Refresh → `min-h-12 min-w-12`
- Freshness retry → `min-h-12 min-w-12`
- Admin filters / staff / camps / staff-detail Close / SMS refresh / Change password → `min-h-12` (+ min-w where needed)

### Contrast (computed AA)

- Scanner doctor line: solid `text-brand` (no opacity blend)
- Already-seen copy: solid `text-amber-950`
- Badge tones: solid token pairs (`brand-soft`/`brand`, `warning-soft`/`warning`) — no opacity-blended ink

### 200% text zoom reflow

- Shell header stacks actions under title on narrow viewports
- `overflow-x: clip` on html/body; grids use `minmax(min(100%, …rem), 1fr)`
- Mobile dock: auto-fit columns (no fixed 4-col forced squeeze)

### Browser proof

New suite: `e2e/a11y-computed.spec.ts`

- Bounding-box assertions (48×48) on Volunteer, Doctor, Admin, print, check-in/lost-slip
- Computed contrast (opacity + ancestor bg blend) for scanner help / badges
- `:focus-visible` paint (outline/ring) via `focus({ focusVisible: true })`
- Interactive scan (name + size) across operational routes
- 200% root text size: no 2D page scroll; critical actions operable
- Disabled assign: distinguishable (`opacity < 1`) and still visible

Source locks remain **supplemental** in `tests/a11y-field.test.mjs` (`#69 … declare ≥48px classes`).

## Before / after (representative)

| Control | Before | After (browser) |
|---|---|---|
| Seat Refresh height | ~32px (`min-h-8`) | **48px** × 72px |
| Admin filter chips | `min-h-9` | **48×48** floor (All chip 48×48) |
| Open camera / Look up | already ≥48 | 302×52 (mobile) |
| Scanner help contrast | n/a token check | **7.58:1** muted on white |
| Brand/80 on soft (defect) | ~3.38:1 | removed; solid brand ink |

Artifacts:

- `.scratch/remediation-69/volunteer-desk-measurements.json`
- `.scratch/remediation-69/admin-filter-measurements.json`
- `.scratch/remediation-69/disabled-assign-contrast.json`
- Screenshots: `volunteer-mobile.png`, `doctor-desktop.png`, `admin-desktop.png`, `login-200pct-text.png`, `volunteer-200pct-text.png`, `print-mobile.png`

## Acceptance matrix

| Criterion | Result | Evidence |
|---|---|---|
| Operational controls ≥48×48 or documented exception | Pass | E2E bounding boxes + interactive scan 0 failures |
| Normal text ≥4.5:1 computed | Pass | scanner help 7.58:1; solid badge tokens |
| Keyboard focus visible | Pass | `assertFocusVisible` on camera, lookup, print, check-in |
| 200% text zoom operable, no 2D scroll | Pass | login + volunteer zoom tests |
| Loading/empty/error/success/disabled browser coverage | Pass | disabled assign; print; scan paths |
| Source-only not presented as proof | Pass | browser suite is primary; source supplemental |
| `npm run verify` | Pass | 340 tests, lint, build, JS budgets |
| `npm run test:e2e` | Pass | **33/33** |

## Coverage delta

| Was | Now |
|---|---|
| Token/class string asserts only | **Browser** bounding boxes + computed contrast + focus + zoom |
| No seat-refresh size proof | Seat Refresh measured **48px** height |
| No opacity-blend contrast proof | Effective fg after opacity measured in page |

## Intentional exceptions

None silent. Inline prose links inside `p.prose-help` may be shorter than 48px height; scanner suite marks them as `[inline exception]` only when nested in prose.

## Gates

```
npm run verify   → 340 pass; build OK; JS budgets OK
npm run test:e2e → 33 passed (3.4m)
```

Logs: `ticket-69-verify.log`, `ticket-69-e2e.log` (this directory).
