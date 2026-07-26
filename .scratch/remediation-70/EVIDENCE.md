# Evidence — #70 FCFS status-page queue position

## Outcome

Atomic `public.patient_status_by_token(p_token text)` SECURITY DEFINER RPC computes
1-based FCFS queue position among camp waiting peers ordered by
`(queued_at ASC NULLS LAST, reg_no ASC, id ASC)`. Status page calls this RPC only;
secondary ignored count query removed.

## Gates

| Check | Result | Notes |
|---|---|---|
| Migration apply | PASS | `npx supabase migration up` → 20260726200000_status_queue_position_fcfs.sql |
| `node --test tests/status-queue-position.db.test.mjs` | PASS exit 0 | 11 pass / 0 fail |
| `npm run test:db` | PASS exit 0 | 62 pass / 0 fail (includes new file) |
| `npm run verify` | PASS exit 0 | lint + 241 unit tests + build + js budget |
| `npm run test:e2e` | PASS exit 0 | 14 passed (48.5s) |

## Coverage delta

- **DB:** 11 new cases (timestamps, reg_no/id ties, camp isolation, non-waiting excluded,
  waiting→seen NULL, invalid tokens empty, authz deny EXECUTE, null input, concurrent
  distinct ranks, least-privilege projection columns)
- **App:** 4 new cases (Server Component, RPC-only wiring, error vs notFound, mapper)

## Files (shipped)

- `supabase/migrations/20260726200000_status_queue_position_fcfs.sql`
- `src/app/s/[token]/page.tsx`
- `src/app/api/desk/live/route.ts` (align order: reg_no, id after queued_at)
- `tests/status-queue-position.db.test.mjs`
- `tests/status-queue-position.test.mjs`
- `package.json` (`test:db` registers new file)

## Commit

- SHA: `45a8a792fb6c58cdd79fc73657f41e2f7f010147`
- Message: `fix(status): FCFS queue position in atomic status RPC (#70)`
- Branch: `fix/gate-a-56-57-58` (pushed to origin)

## Rollback

1. Revert page.tsx + desk live order + tests + package.json
2. `DROP FUNCTION IF EXISTS public.patient_status_by_token(text);`
3. Or reverse migration commit; function is append-only and has no table side effects

## Logs

- `.scratch/remediation-70/status-queue-position.db.log`
- `.scratch/remediation-70/test-db.log`
- `.scratch/remediation-70/ticket-70-verify.log` (or temp implementer path)
- `.scratch/remediation-70/ticket-70-e2e.log`
- `C:\Users\piyus\AppData\Local\Temp\grok-goal-a5c888ca8289\implementer\ticket-70-verify.log`
- `C:\Users\piyus\AppData\Local\Temp\grok-goal-a5c888ca8289\implementer\ticket-70-e2e.log`
