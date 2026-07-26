# #65 Evidence — Persist SMS delivery state

Date: 2026-07-26  
Branch: `fix/gate-a-56-57-58`  
Migration: `supabase/migrations/20260726190000_sms_deliveries_ledger.sql`  
Tests: `tests/sms-deliveries.db.test.mjs` + updated reminder/registration/cron/admin tests

## State transition table

| From | Event | To | Auto-retry? |
|---|---|---|---|
| (none) | register with phone / claim ensure | `pending` | — |
| `pending` | claim | `sending` (+ lease, attempt++) | — |
| `failed` | claim | `sending` | yes (known rejection) |
| `sending` + expired lease | claim | `sending` (new token) | reclaim crash-before-dispatch |
| `sending` | complete sent | `sent` | no |
| `sending` | complete failed (provider rejection) | `failed` | yes (later claim) |
| `sending` | complete ambiguous (timeout/network) | `ambiguous` | **no** |
| `sending` | complete release (unconfigured) | `pending` | yes |
| `sent` / `ambiguous` | claim | no-op | no |

## Fix summary

1. **`sms_deliveries`** ledger: unique `(patient_id, kind)` for `registration` \| `reminder`; states above; redacted `phone_last4` only; no message body / full phone / status token / secrets.
2. **Registration RPC** transactionally inserts `pending` registration delivery when phone present (browser cancel cannot erase work).
3. **`claim_sms_delivery` / `complete_sms_delivery`** SECURITY DEFINER; staff or service_role; dual-writes legacy `reminder_sms_sent_at` during compatibility.
4. **Notify route** claims + sends + completes; unconfigured leaves pending.
5. **Reminder cron** uses ledger claims (two runners: one wins); list/schema failure → HTTP 500 + `ok:false`; per-patient failures stay 200 with counts including `ambiguous`.
6. **Admin GET** lists durable failed/ambiguous via `list_recent_sms_delivery_issues`.
7. **Retention:** `prune_sms_deliveries` — sent 30d, failed/ambiguous 90d.
8. **Backfill:** existing `reminder_sms_sent_at` → ledger `sent`.

## Verification

| Gate | Result |
|---|---|
| `tests/sms-deliveries.db.test.mjs` | **8/8** |
| `npm run test:db` | **51/51** |
| `npm run verify` | pass — lint, **226** tests, build, JS budgets |
| `npm run test:e2e` | **14/14** |
| Clean migration replay | **pass** through `20260726190000_sms_deliveries_ledger.sql` |

## Operator notes

- Ambiguous rows need manual investigation (MSG91 dashboard / resend policy) — not auto-retried.
- Failed rows are reclaimable on next cron / notify claim.
- Legacy `reminder_sms_sent_at` still dual-written; retire in a later append-only migration after production confidence (#68 chain).
- Production deploy still requires **#34**.

## Rollback

Keep ledger rows. Function-only rollback of register/claim/complete is possible; do not treat `sending`/`ambiguous` as safe auto-resend without human review.
