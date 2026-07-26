# #62 Evidence — Register-and-Print survives popup block + Try Again

Date: 2026-07-26  
Branch: `fix/gate-a-56-57-58` (tip after #61 `fc9c9e9`)  
Issue: [#62](https://github.com/Piyushmanyata/snp-camps/issues/62)

## Defect (red)

1. **Print window opened only after async RPC + 250/750 ms backoffs** → user activation expired; popup blocked after patient saved.
2. **`window.open(..., "noopener,noreferrer")` return ignored** → form reset claimed “Print window khuli” even when blocked.
3. **No E2E** covering real register → print-target branches (allowed / blocked / closed).
4. **Exhausted transient** copy said “press Try Again” but primary submit label simply returned — no explicit Try Again control; fields/request-id path was easy to lose in UX terms.

## Fix

### Pure seam — `src/lib/desk-register-flow.ts`

| Export | Behavior |
|---|---|
| `DeskSubmitPhase` | `idle \| saving \| failed-retryable \| registered-print-ready` |
| `patientPrintPath` | `/print/{id}?auto=1` |
| `acquireDeskPrintTarget(openWindow)` | Sync `about:blank` open **without** `noopener`; set `opener = null`; `navigate` / `abandon` |
| `runDeskRegisterAndPrint` | Retries transient only (#60); **abandon** target on any failure; **navigate** after success; `print: navigated \| recovery`; `onSuccess` **before** rotate/reset; `showTryAgain` only for exhausted copy |

### UI — `src/components/patient-form.tsx`

- Acquire print target **during submit gesture before any await**.
- Phases + `printRecovery` card with deterministic **Print desk slip** (never re-registers).
- Truthful flash: “Print window open” vs “Print blocked — use Print below.”
- Explicit **Try Again** when `phase === failed-retryable` (same request id; fields preserved).
- Form reset/focus only after `onSuccess` retains recovery reference.

### Tests

- Unit: blocked vs handle, opener severed, abandon on fail/duplicate, recovery path, request-id stability, no noopener features.
- E2E `e2e/register-print.spec.ts`: delayed success + 2 auto-retries → navigated popup; blocked `window.open=null` → recovery + 1 RPC; closed target → recovery; exhausted → Try Again + same `p_request_id`; terminal capacity → no connectivity Try Again.
- E2E cleanup: delete prefix / day / camp patients before dropping fixture day/camp (`global-setup.ts`).

## Acceptance matrix

| Criterion | Result | Evidence |
|---|---|---|
| Delayed RPC → pre-opened target navigates to slip | Pass | E2E delayed success |
| Opener severed before await; navigable | Pass | unit `opener-null` before caller work |
| No `noopener` on retained-handle branch | Pass | unit + E2E open-args assert |
| Blocked open → one register + recovery Print | Pass | E2E blocked + `getCalls()===1` |
| Closed target → recovery, patient saved | Pass | E2E closed target |
| Failures abandon blank tab | Pass | unit abandon on day-full / exhausted / likely-dup |
| Exhausted: fields + request id + Try Again | Pass | unit + E2E |
| Terminal business: no connectivity Try Again | Pass | unit + E2E capacity |
| Reset after recovery retained | Pass | `onSuccess` before `resetForm` |
| SMS non-blocking | Pass | existing registration-sms test (printTarget) |

## Gates

| Gate | Result | Log |
|---|---|---|
| `npm run verify` | **Pass** (316 unit tests, lint, build, JS budget) | `ticket-62-verify.log` |
| `npm run test:e2e` | **Pass** 19/19 | `ticket-62-e2e.log` (19 passed, 1.1m) |
| `npm run test:db` | Not required (no schema change) | — |

## Coverage delta

- `tests/desk-register-flow.test.mjs`: +print-target / recovery / showTryAgain cases.
- `e2e/register-print.spec.ts`: new file (5 scenarios).
- `e2e/global-setup.ts`: safer fixture teardown after desk register.

## Rollback

If pre-open proves incompatible on a target browser: keep registration + post-success recovery Print; never restore false “opened” claims or re-register-for-print.

## Commit

`fix(register): survive popup block and explicit Try Again (#62)`
