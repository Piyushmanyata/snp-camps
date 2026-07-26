# #67 Evidence — Serialize concurrent likely-duplicate checks

Date: 2026-07-26  
Branch: `fix/gate-a-56-57-58` (stacked after #56–#59)  
Migration: `supabase/migrations/20260726180000_serialize_likely_duplicate_checks.sql`  
Tests: `tests/likely-duplicate-concurrency.db.test.mjs`

## Defect (red)

`register_patient_idempotent` held only a request-id advisory lock. Two desks with **different request IDs** for the same normalized soft keys could both pass the warn-before-insert check and insert.

Same-day races are partially masked by `camp_days … FOR UPDATE` (seat lock). The durable race is **same camp, different camp days** (no shared day row lock). Sequential unit tests never exposed it.

## Interleaving schedule (core proof)

1. Conn A: `BEGIN` → register name+age key K on day1 → **hold open** (uncommitted insert)
2. Conn B: `BEGIN` → register same key K on day2 (different day → no shared seat lock)
3. Without soft locks: B also inserts (check-then-insert race)
4. With camp-scoped soft locks: B blocks on `pg_advisory_xact_lock` until A commits, then soft re-check raises `LIKELY_DUPLICATE:reg=N` and inserts 0 rows

Assertions: final patient count = 1; override path attributes `likely_duplicate_override_by`; unrelated keys do not wait on A’s open txn; two-key stress (name-age + phone) completes without deadlock for 8 rounds.

## Fix summary

Before soft lookup (after seat check + phone/name normalize):

1. Build lock key strings for present soft keys only:
   - `name-age:{camp_id}:{full_name_normalized}:{age}`
   - `phone:{camp_id}:{phone10}`
2. Sort keys lexicographically; acquire `pg_advisory_xact_lock(hashtext('snp-reg-likely-dup'), hashtext(key))` in that order
3. Re-run soft duplicate SELECT against committed state
4. Existing warn / one-shot override / Aadhaar / seat / request-id idempotency unchanged

Locks use normalized/redacted inputs only (no full Aadhaar). Hash collisions only add extra serialization.

## Verification

| Gate | Result |
|---|---|
| `tests/likely-duplicate-concurrency.db.test.mjs` | **6/6** |
| `npm run test:db` | **43/43** |
| `npm run verify` | pass — lint, **216** tests, build, JS budgets |
| `npm run test:e2e` | **14/14** (re-run after clean reset; first e2e race with concurrent reset discarded) |
| Clean migration replay | **pass** — `supabase db reset --yes` through `20260726180000_serialize_likely_duplicate_checks.sql` |

## PII / log check

- Lock material: camp UUID + normalized name/age or 10-digit phone hash only (no status tokens, no full Aadhaar)
- Tests assert reg numbers and result codes only; no patient phone dump in assertions

## Rollback

Function-only: replace `register_patient_idempotent` with prior body from `20260726170000_…` (or a new migration). Do **not** drop soft-key serialization without a replacement deterministic transaction lock.

## Coordination

- Does not change RPC signature → safe for #65 / #66 / #68 stacking
- Next ticket in order: **#65** durable SMS enqueue (then #68 final; #70 after #56 before #68; #66 before #68)
