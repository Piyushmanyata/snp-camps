# #61 Evidence — Lost-slip search + recoverable check-in

Date: 2026-07-26  
Branch: `fix/gate-a-56-57-58` (tip after #60 `ee72ee6`)  
Issue: [#61](https://github.com/Piyushmanyata/snp-camps/issues/61)

## Defect (red)

1. **Search failures → empty array** in `check-in.tsx` (`setMatches(err ? [] : …)`), so network/RLS looked like “No registered patients match.”
2. **Prefix-only SQL** despite `patients_full_name_trgm_idx` — one-character typos and simple transpositions never matched.
3. **Check-in single-attempt** across reg / QR paste / name row / scanner / likely-duplicate, though RPC is idempotent.
4. **Likely-duplicate path** rendered `err.message` (raw DB text) to the volunteer.
5. **Scanner check-in failure** set `handledRef = false`, so the same QR could re-fire unbounded after exhaustion.

## Fix

### Migration `20260726230000_search_registered_patients_trigram.sql`

- Replace `search_registered_patients`:
  - Scope unchanged: `queue_status = 'registered'`, active camp only.
  - Exact normalized prefix **or** (query length ≥ 3 and `similarity ≥ 0.35` or `word_similarity ≥ 0.40`).
  - Order: prefix first → greatest(similarity, word_similarity) DESC → `full_name_normalized` → `reg_no`.
  - Hard cap **10** rows (desk disambiguation).
- Bump `EXPECTED_MIGRATION_HEAD` → `20260726230000`.

### Shared desk ops (`src/lib/desk-ops.ts`)

| Export | Behavior |
|---|---|
| `checkInPatientWithRetries` | #60 classifier; 3 attempts on transient only; `already_seen` terminal safe copy; exhausted → internet Try Again copy |
| `searchRegisteredPatientsWithRetries` | Failures → `{ ok: false, error }`; empty rows → `{ ok: true, rows: [] }` never collapsed |

### Wiring

| Entry point | Change |
|---|---|
| `check-in.tsx` | Search UI states `idle \| loading \| results \| empty \| error`; Try Again for search + check-in; preserve query / selected id |
| `qr-scanner.tsx` | Shared check-in; **freeze** decoder after camera check-in terminal/exhaustion |
| `patient-form.tsx` | Shared check-in for likely-duplicate; no raw `err.message` |
| `with-retries.ts` | `RETRY_EXHAUSTED_COPY.checkIn` / `.search` |

## Ranking / EXPLAIN (seeded)

Thresholds (migration comments): `similarity ≥ 0.35`, `word_similarity ≥ 0.40`, fuzzy only when `length(query) ≥ 3`.

Captured on local Supabase with 30 “Suresh Patient N” + “Priya Sharma” (`explain-search.txt`):

```
=== PREFIX sure ===
Function Scan on search_registered_patients  … rows=10 … Execution Time: ~1.8 ms
  Buffers: shared hit=835

=== FUZZY pirya sharma ===
Function Scan on search_registered_patients  … rows=1 … Execution Time: ~0.4 ms
  Buffers: shared hit=5
```

RPC body is plpgsql STABLE; inner path uses registered filter + `patients_full_name_trgm_idx` / prefix index for the fuzzy/prefix predicates (see DB tests).

## Unit / DB matrix

| Case | Result |
|---|---|
| Search empty rows | `ok: true, rows: []` (not error) |
| Search 42501 / XX000 | `ok: false`, no empty-success, no raw SQL text |
| Search transport | 3 calls → exhausted search copy |
| Check-in 08006 / 40001 | retries; success keeps same patient id |
| Check-in already_seen | 1 call, “Already seen by …” |
| Check-in 42501 | 1 call, permission copy, no function name |
| Scanner freeze | same code blocked until unfreeze |
| DB typo `suresha` → Suresh Patel | pass |
| DB transposition `pirya sharma` → Priya Sharma | pass |
| Exact prefix ranks first | pass |
| Waiting / seen / other-camp excluded | pass |
| Cap 10 + deterministic order | pass |
| Idempotent waiting queued_at | unchanged (existing test) |

## Gates

| Gate | Result | Log |
|---|---|---|
| `npm run test:db` | **81/81** | `test-db.log` |
| `npm run verify` | **pass** — lint, **309** tests, build, JS budgets | `ticket-61-verify.log` |
| `npm run test:e2e` | **14/14** | `ticket-61-e2e.log` |

## Rollback

If fuzzy ranking is too broad: keep error≠empty + shared check-in retry; raise thresholds or disable fuzzy branch only. **Never** restore failure-as-empty or raw DB text to workers.

## Files

- `supabase/migrations/20260726230000_search_registered_patients_trigram.sql`
- `src/lib/readiness-contract.ts`
- `src/lib/desk-ops.ts`
- `src/lib/with-retries.ts`
- `src/components/check-in.tsx`
- `src/components/qr-scanner.tsx`
- `src/components/patient-form.tsx`
- `tests/desk-ops.test.mjs`
- `tests/check-in.db.test.mjs`
- `tests/qr-scan-session.test.mjs`
