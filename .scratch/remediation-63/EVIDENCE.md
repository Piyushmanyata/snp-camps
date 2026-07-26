# #63 Evidence — Isolate section failures; remove raw error surfaces

Date: 2026-07-26  
Branch: `fix/gate-a-56-57-58`  
Issue: [#63](https://github.com/Piyushmanyata/snp-camps/issues/63)  
Base tip: `8fc8648` (#62)

## Defects addressed

1. **Section retry always full route refresh** — `SectionLoadError` used only `router.refresh()`, re-running every desk query.
2. **Admin Suspense throws blanked the dashboard** — section loaders threw inside Suspense (not an error boundary).
3. **Raw Auth/provider strings** — login fell through to `err.message`; change-password showed `err.message`.
4. **Queue/seat refresh failures** — soft failures needed distinct hard-error vs stale-error copy and known-snapshot flags.

## Fix summary

### Narrow section read seam

| Piece | Role |
|---|---|
| `src/lib/section-reads.ts` | Server loaders return `{ ok, data } \| { ok, error }` — never throw for expected query failures |
| `src/app/api/desk/section/route.ts` | One section per request (`queue`, `seats`, `volunteer-kpis`, `doctors`, `doctor-stats`, `doctor-seen`, `admin-queue-counts`) |
| `src/lib/section-client.ts` | Client fetch of one section; injectable `fetchImpl` for call-count tests |
| `src/components/section-data.tsx` | Recoverable islands for KPIs / doctor stats / doctor seen / admin header |
| `src/components/desk-scan-queue.tsx` | Client scanner+queue island; doctors retry hits only `section=doctors` |

### SectionLoadError

- Requires `onRetry` (narrow seam).
- **No** `useRouter` / `router.refresh` default path.

### Desk live freshness (#56 extended)

- `waitingKnown` / `daysKnown` seed flags.
- Freshness `error` (no known snapshot) vs `stale-error` (preserve rows + amber banner).
- LiveQueue/SeatBoard: empty success ≠ hard failure copy; `role="alert"` on hard failure.

### Raw error surfaces

- `mapAuthError` in `public-error.ts` — credentials, rate limit, weak password, unknown → safe copy; raw log-only.
- Login + change-password use `mapAuthError`.
- Print-actions avoids leaking unexpected stack/provider text.

### Admin / volunteer / doctor pages

- Independent `Promise.all` section results; no throw into Suspense for stats/queue/seats/ops.
- Admin camps foundation failure → isolated card (reload last resort), password/SMS siblings still mount.
- Patient desk: list failure recoverable; stats failure non-fatal.

### E2E setup resilience

- `createStaff` no longer installs a mock password when Auth create fails; resets password via profiles id when user already exists (`listUsers` 500s observed on local Auth).

## Call-site inventory (worker-facing)

| Surface | Before | After |
|---|---|---|
| `SectionLoadError` | `router.refresh()` | required `onRetry` |
| Volunteer KPIs/doctors/queue/seats | full refresh / block mount | island + desk-live known flags |
| Doctor stats/seen | Suspense section + full refresh | `DoctorStatsPanel` / `DoctorSeenPanel` → `doctor-stats` / `doctor-seen` only |
| Admin header/queue/seats | throw in Suspense | result models + islands |
| Login | raw `err.message` fallback | `mapAuthError` |
| Change password | `err.message` | `mapAuthError` |

## Tests

| Suite | Result |
|---|---|
| `tests/section-isolation.test.mjs` | call isolation, error vs stale, mapAuthError, wiring |
| `tests/camp-desk-live.test.mjs` | stale-error preserves rows; initial error |
| `npm run verify` | **331** tests pass; lint; build; JS budgets |
| `npm run test:e2e` | **19/19** |

### Call isolation (behaviour)

- `fetchDeskSection("queue")` URL contains only `section=queue` (not seats/doctors/kpis).
- Sequential doctors / volunteer-kpis / doctor-stats each hit their own `section=` only.

### Sample redacted log

```
[db-error] login.sign-in {
  code: 'invalid_credentials',
  message: 'Invalid login credentials',  // log-only
  category: 'validation',
  retryable: false
}
```

UI: `Wrong email or password. Check and try again.`

## Gates

| Gate | Result | Log |
|---|---|---|
| `npm run verify` | **pass** — 331 tests | `ticket-63-verify.log` |
| `npm run test:e2e` | **19/19** | `ticket-63-e2e.log` |

## Rollback

- Prefer leaving a section in failed state with explicit Retry over restoring `router.refresh`-only recovery or silent empty.
- Do not reintroduce `err.message` on login/change-password.
- Do not re-throw expected query failures through Suspense without a result model.

## Commit

`fix(ui): isolate section failures; remove raw error surfaces (#63)`
