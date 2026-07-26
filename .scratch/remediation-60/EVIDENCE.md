# #60 Evidence — Structured errors; retry only transient desk failures

Date: 2026-07-26  
Branch: `fix/gate-a-56-57-58` (tip after #68 `fc542a0`)  
Issue: [#60](https://github.com/Piyushmanyata/snp-camps/issues/60)

## Defect (red)

1. **Registration** (`isRetryableRegistrationError`) treated every non-duplicate error as retryable. Day full, inactive camp, RLS, validation, and schema/business raises burned three RPC calls and often ended as the false internet copy.
2. **Desk ops** discarded Supabase `code` / `details` / `hint` at component adapters (`error: { message: result.error.message }` only) and used an English-message deny-list (`isNonTransientRpcMessage`) for terminal vs retry.
3. **Tests** fed synthetic strings (`"network"`, `"full"`, `"blip"`) rather than SQLSTATE / PostgREST shapes.

## Fix

### Shared classifier (`src/lib/public-error.ts`)

- `classifyOperationError(error, options)` → `{ retryable, publicCategory, publicMessage, logCode, rawMessage }`
- Retry is an **allow-list** only:
  - `transportFailure` / `timedOut` flags
  - HTTP status ≥ 500
  - SQLSTATE connection class `08*`
  - `40001` serialization, `40P01` deadlock
  - `57014` statement timeout, `57P03`, `53300`
  - Last-resort legacy transport/timeout **message** patterns when no code
- Everything else (P0001 business raises, 42501, 23505, PGRST116, unknown XX000, capacity phrases, duplicates) is **terminal**
- `mapDbError` / `publicRegistrationError` / `isRetryableDbError` share the same seam
- Logs include `code`, `category`, `retryable`, context — not phone/Aadhaar/token/full patient data

### Wiring

| Path | Change |
|---|---|
| `registration-request.ts` | Preserves full error; returns `retryable` + `logCode` + `publicCategory` from classifier |
| `desk-register-flow.ts` | Retries only when `retryable === true` |
| `desk-ops.ts` | Classifies before retry loop; no English deny-list |
| `patient-form`, `live-queue`, `change-day`, `qr-scanner` | Pass `code`/`details`/`hint` through RPC adapter; `errorContext`/`errorFallback` |

### Capacity (#66)

`SEAT_LIMIT_BELOW_ASSIGNED:taken=N` and day-full raises → `publicCategory: capacity`, `retryable: false`, worker copy with count / “Choose another day.”

## Classification matrix (unit)

| Case | Shape | Calls (max) | retryable | Public copy class |
|---|---|---:|---|---|
| Transport throw | `Failed to fetch` / flag | 3 | yes | exhausted internet copy |
| Connection | `08006` | 3 | yes | exhausted |
| Serialization | `40001` | ≤3 | yes | — |
| Deadlock | `40P01` | ≤3 | yes | — |
| Statement timeout | `57014` | 3 | yes | exhausted |
| HTTP 503 | `status: 503` | ≤3 | yes | — |
| RLS / privilege | `42501` | **1** | no | permission |
| Unique | `23505` | 1 | no | conflict |
| Not found | `PGRST116` | 1 | no | not_found |
| Invalid input | `22P02` | 1 | no | validation |
| Schema cache | `PGRST202` / `42P01` | 1 | no | generic |
| Day full | `P0001` + full phrase | **1** | no | capacity |
| Seat limit below | `SEAT_LIMIT_BELOW_ASSIGNED` | 1 | no | capacity |
| Unknown | `XX000` | **1** | no | generic (not internet) |
| Aadhaar / likely dup | domain message | 1 | no | form actions keep raw |
| check_in_required | RPC `error_code` | 1 | n/a terminal result | worker copy |
| already_seen | RPC row | 1 (success) | n/a | success |
| Success on 2nd | 08006 then OK | 2 | — | success |

## Idempotency (unchanged contracts)

- Registration: same `p_request_id` across retries
- Assign: same `p_doctor_id` on every attempt; `already_seen` terminal success
- Change-day: same `p_new_day_id`; seat lock in RPC
- Check-in: still uses `mapDbError` (shared classifier for copy); RPC idempotent when user retries

## Log redaction sample

```
[db-error] desk-ops.assign {
  code: '42501',
  message: 'permission denied for table patients',  // log-only
  category: 'permission',
  retryable: false
}
```

UI: `You do not have permission for this action.` (no table name)

## Gates

| Gate | Result | Log |
|---|---|---|
| Targeted unit (public-error, desk-ops, desk-register-flow, registration-request, with-retries) | **70/70** | console |
| `npm run verify` | **pass** — lint, **292** tests, build, JS budgets | `ticket-60-verify.log` |
| `npm run test:e2e` | **14/14** | `ticket-60-e2e.log` |
| `npm run test:db` | not required (no schema/migration change) | — |

## Rollback

Do **not** restore broad retry. If a new code is uncertain, keep it terminal and gather evidence; add to the allow-list only when proven transient and safe under existing idempotency.

## Files

- `src/lib/public-error.ts`
- `src/lib/registration-request.ts`
- `src/lib/desk-register-flow.ts`
- `src/lib/desk-ops.ts`
- `src/components/patient-form.tsx`
- `src/components/live-queue.tsx`
- `src/components/change-day.tsx`
- `src/components/qr-scanner.tsx`
- `tests/public-error.test.mjs`
- `tests/desk-ops.test.mjs`
- `tests/desk-register-flow.test.mjs`
