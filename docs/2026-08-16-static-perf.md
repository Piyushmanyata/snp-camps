# Static performance report — 16 Aug 2026

No Lighthouse, page-load, or query timings were measured. Numbers are
gzipped eager-initial client JS from `npm run check:js-budget` after
`npm run build` (Next.js 16.2.11 / Turbopack).

## Top five (fixed)

| Rank | Finding | Before | After |
|---|---|---|---|
| 1 | `/admin/manual-exceptions` budget sat at 282000 above measured ~269k | budget 282000 / measured 269598 | budget **278000** (`ceil(269598×1.03/1000)×1000`, never-raise) |
| 2 | 58mm Devanagari via `next/font` would blow `/clinical/slip/[id]` | next/font would add tens of KB JS | `@font-face` + 17 712-byte `public/fonts/slip-devanagari.woff2`; slip JS **195000 / 200000** |
| 3 | Admin OT setter on `/admin` must not grow the eager graph | risk of adding OT form to 288k initial | `next/dynamic` — `/admin` initial **288369 / 297000**, OT chunk in deferred **186495** |
| 4 | Deleted `/lookup` and `/s/[token]` still listed as eager-marker routes | aliases in `scripts/check-js-budget.mjs` | aliases removed; those routes are absent from `js-route-budgets.json` |
| 5 | Volunteer confirmation/scanner must stay off the eager path | volunteer 277857 with 191459 deferred | unchanged shape: initial **277857 / 285000**, deferred **191459** (scanner + confirmation) |

All listed routes stay inside budget. Unused leftover budgets for retired
public status/lookup routes were already absent from `js-route-budgets.json`.

## Not claimed

Query shapes, N+1, and real page-load times are unverified without a
running app or database.

Outstanding: physical 58mm print, DLT approval, Docker `test:db` /
`test:e2e` / `test:db:replay`.
