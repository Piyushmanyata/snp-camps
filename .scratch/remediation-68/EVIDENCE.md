# #68 Evidence — Fail-closed readiness + clean replay

Date: 2026-07-26  
Branch: `fix/gate-a-56-57-58` (stacked after #66 tip `3cbf528`)  
Commit: `fc542a0` — `fix(ops): fail-closed readiness + clean replay contract (#68)`

## Defect (red-before)

`GET /api/health?ready=1` treated migration-head discovery as decorative metadata:

1. `latest_applied_migration` error → `migrationVersion: null`
2. Final `ok` depended only on table-shape probes
3. Head mismatch still returned **HTTP 200**

Captured (pre-change) in `red-before.txt`:

| Scenario | Status | Body |
|---|---|---|
| Migration discovery error, tables OK | **200** | `{ ok: true, checks: { database: true }, migrationVersion: null }` |
| Head mismatch (`old-head-999`) | **200** | `{ ok: true, …, migrationVersion: "old-head-999" }` |

Schema probe also omitted SMS ledger, grants, Realtime publication, and head agreement.

## Fix summary

Fail-closed readiness with independent checks:

| Check | Source |
|---|---|
| `database_reachability` | service-role `camps` probe + timeouts |
| `migration_head_discovery` | `latest_applied_migration()` must return non-empty string |
| `applied_head_agreement` | applied === `EXPECTED_MIGRATION_HEAD` |
| `schema_contract` | versioned tables/columns/functions |
| `rpc_grants` | least-privilege grant facts |
| `patients_realtime_absent` | `patients` ∉ `supabase_realtime` |
| `sms_ledger` | table + states/kinds + claim/complete RPCs |

- Contract: `src/lib/readiness-contract.ts` (`READINESS_CONTRACT_VERSION=1`, head `20260726220000`)
- Evaluator: `src/lib/readiness.ts` (bounded timeouts; safe JSON only)
- Catalog RPC: migration `20260726220000_readiness_catalog_probe.sql` (service_role only)
- Route: `src/app/api/health/route.ts` — liveness stays independent (`?ready` absent)
- Clean replay: `npm run test:db:replay`
- Read-only compare: `npm run compare:migrations`
- Operator docs: `docs/ops-readiness.md` + README update

## Green-after (unit mock)

From `green-responses.txt`:

| Scenario | Status | failedCheck |
|---|---|---|
| Fully aligned | **200** | null |
| Discovery fail | **503** | `migration_head_discovery` |
| Head mismatch | **503** | `applied_head_agreement` |
| Unreachable | **503** | `database_reachability` |

## Gates

| Gate | Result | Evidence |
|---|---|---|
| `npm run test:db:replay` | **75/75** pass, exit 0 | `ticket-68-replay.log` |
| Health unit tests | **15/15** | included in verify |
| `npm run test:db` | **75/75** | `test-db.log` |
| `npm run verify` | lint + **266** tests + build + JS budgets, exit 0 | `ticket-68-verify.log` |
| `npm run test:e2e` | **14/14** | `ticket-68-e2e.log` |
| `compare:migrations --require-local` | repo=contract=local=`20260726220000` | `compare-heads.log` |

## Coverage delta

- **Added:** fail-closed readiness unit cases (discovery, mismatch, grants, realtime, SMS, timeout, secrets); real-DB catalog probe suite (`tests/readiness.db.test.mjs`); clean-replay npm script; read-only head compare script.
- **Removed:** none (legacy weak `checks.database` / `migrationVersion` replaced by richer fail-closed shape).
- **Not claimed:** client Realtime subscription absence (#56/#72); production apply (#34).

## Files (implementation)

- `src/lib/readiness-contract.ts` (new)
- `src/lib/readiness.ts` (new)
- `src/app/api/health/route.ts`
- `supabase/migrations/20260726220000_readiness_catalog_probe.sql` (new)
- `tests/health.route.test.mjs`
- `tests/readiness.db.test.mjs` (new)
- `scripts/compare-migration-heads.mjs` (new)
- `package.json` (`test:db` + `test:db:replay` + `compare:migrations`)
- `README.md`, `docs/ops-readiness.md` (new)
