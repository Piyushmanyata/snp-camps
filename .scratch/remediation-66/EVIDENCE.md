# #66 Evidence — Serialize camp-day capacity edits with registrations

Date: 2026-07-26  
Branch: `fix/gate-a-56-57-58` (stacked after #70 tip `45a8a79`)  
Migration: `supabase/migrations/20260726210000_serialize_camp_day_capacity.sql`  
Tests: `tests/camp-day-capacity-concurrency.db.test.mjs`

## Defect (red)

`upsert_camp_day` (existing-day `p_day_id` path) counted assigned patients **before** acquiring the `camp_days` row lock:

1. Admin `SELECT count(*)` → N  
2. Registration `SELECT camp_days FOR UPDATE` → insert patient N+1 → commit  
3. Admin `UPDATE seat_limit = N` (validation already passed on stale N)

Result: committed `seat_limit < patients` on that day.

Registration already locked correctly (`FOR UPDATE` then count then insert). The insert/upsert-by-date branch did not have the same ordering defect; both paths are now lock-first for consistency.

## Lock order (documented)

Shared capacity critical section for **registration**, **change_camp_day**, and **upsert_camp_day**:

1. **`camp_days` row lock** — `SELECT … FROM camp_days … FOR UPDATE`  
   (by day id, or by `camp_id + day_date` for upsert-by-date)
2. **Count** patients assigned to that day (under the same lock)
3. **Mutate** — insert patient / update `seat_limit` / insert new day, **or** raise terminal capacity error

Registration may take soft-duplicate advisory locks **after** the day row lock. Camp-day edit never takes soft locks. Single shared order avoids deadlock.

Also stored as:

- Migration header comment on `20260726210000_serialize_camp_day_capacity.sql`
- `COMMENT ON FUNCTION public.upsert_camp_day(...)`

## Fix summary

`CREATE OR REPLACE public.upsert_camp_day`:

- `p_day_id` path: `FOR UPDATE` by id+camp ownership → count → update or `SEAT_LIMIT_BELOW_ASSIGNED:taken=N`
- Upsert-by-date path: `FOR UPDATE` by camp+date when row exists → same validate order
- New day: insert only (no assignments yet)
- Stable structured rejection: `SEAT_LIMIT_BELOW_ASSIGNED:taken=<n>` (maps in UI; not connectivity)

Minimal UI: `mapDbError` maps structured + legacy phrases to  
`Seat limit cannot be below N existing bookings` (admin input already retained on error in `admin-camp-days.tsx`).

## Interleaving schedules (two real `pg.Client`s)

### A — Reg holds lock; admin lowers limit

1. Seed: limit=5, 4 committed patients  
2. Conn A: `BEGIN` → register 5th → **hold open**  
3. Conn B: `BEGIN` → `upsert_camp_day(limit=4)`  
4. Assert B not settled after 200ms (blocked on day row lock)  
5. A commits → B rejects `SEAT_LIMIT_BELOW_ASSIGNED:taken=5`  
6. Final: patients=5, seat_limit=5 (≥ count)

### B — Edit locks first; reg follows

1. Seed: limit=5, 4 patients  
2. Conn A admin: `BEGIN` → set limit=4 → **hold**  
3. Conn B reg: register → blocked  
4. A commits → B raises day-full  
5. Final: patients=4, seat_limit=4

### C — Two concurrent regs at final seat

limit=1, empty day → exactly one success; patients=1

### D — Equal/above/below

equal(3) and above(7) succeed; below(2) → `SEAT_LIMIT_BELOW_ASSIGNED:taken=3`

### E — Smoke

Day not found, wrong camp id, non-admin → correct messages; limit unchanged

### Stress

6 reverse interleavings edit↔reg; always `seat_limit >= patient_count`; no deadlock

## Verification

| Gate | Result |
|---|---|
| Clean migration replay (`supabase db reset --yes` through `20260726210000_…`) | **pass** |
| `tests/camp-day-capacity-concurrency.db.test.mjs` | **6/6** |
| `npm run test:db` | **68/68** |
| `npm run verify` | **pass** — lint, **249** tests, build, JS budgets |
| `npm run test:e2e` | **14/14** |

Logs:

- `.scratch/remediation-66/db-reset.log`
- `.scratch/remediation-66/test-db.log`
- `.scratch/remediation-66/concurrency-tests.log`
- `…/implementer/ticket-66-verify.log`
- `…/implementer/ticket-66-e2e.log`

## Rollback

Function-only: replace `upsert_camp_day` body via new migration.  
**Never** restore count-before-lock. Keep structured error code if UI already maps it.

## Coordination

- Does not change RPC signature  
- Does not touch #70 FCFS RPC  
- Ready for #68 stacking after this tip
