# Operations: Readiness and clean replay (#68)

## Liveness vs readiness

| Endpoint | Purpose | DB? | Failure |
|---|---|---|---|
| `GET /api/health` | **Liveness** — process is up | No | Always `200 { ok: true }` |
| `GET /api/health?ready=1` | **Readiness** — safe to serve traffic | Yes (service role) | `503` if any check fails |

Liveness stays independent so orchestrators can restart or probe the process without failing on schema drift. Readiness is **fail-closed**: unknown migration state, timeout, parse/permission/query failure, or contract mismatch all return **HTTP 503**.

Readiness is rate-limited (12 requests / IP / minute).

The response also reports non-blocking integration facts under `integrations`:
`sms`, `aadhaarPepper`, and `cron`.
- **SMS**: Requires `MSG91_AUTH_KEY`, `MSG91_SENDER_ID`, `MSG91_DLT_TE_ID_REGISTRATION` (or `MSG91_TEMPLATE_REGISTRATION`), and `MSG91_DLT_TE_ID_REMINDER` (or `MSG91_TEMPLATE_REMINDER`).
- **Aadhaar pepper**: Requires `AADHAAR_HASH_PEPPER` (or the `AADHAAR_KYC_PEPPER` / `AADHAAR_PEPPER` aliases). It is the HMAC secret behind the Person duplicate key — `HMAC(last4 + normalised name + DOB + gender)` — so both Volunteer Desk card scans and `/self-register` depend on it. Without it a scan still registers the patient, but on the manual path, and global one-Person-per-Aadhaar does not apply. **Pepper Rule**: never rotate it while a Camp is active; every key already stored becomes unmatchable, so returning patients would be registered a second time. The eKYC provider variables are gone (#116 / ADR 0004): the card QR is parsed offline with no provider and no OTP.
- **Cron**: Nightly reminder job requires `CRON_SECRET`.

## Independent checks

Every response includes machine-readable `checks` and optional `failedCheck`:

| Check id | Meaning |
|---|---|
| `database_reachability` | Service-role client can query the database within budget |
| `migration_head_discovery` | `latest_applied_migration()` returned a non-empty version string |
| `applied_head_agreement` | Applied head equals `expectedMigrationHead` from the app contract |
| `schema_contract` | Runtime-critical tables, columns, and functions exist |
| `rpc_grants` | Least-privilege expectations (status token, status RPC, SMS, staff RPCs) |
| `patients_realtime_absent` | `patients` is **not** in `supabase_realtime` publication |
| `sms_ledger` | Durable SMS ledger table, enums, claim/complete RPCs present |

Contract source of truth: `src/lib/readiness-contract.ts`  
Catalog probe (read-only RPC): `public.readiness_catalog_probe()`  
Evaluator: `src/lib/readiness.ts`

## Interpreting failures

Response shape (safe — no secrets, SQL text, PHI, or connection strings):

```json
{
  "ok": false,
  "contractVersion": 1,
  "expectedMigrationHead": "20260726220000",
  "appliedMigrationHead": "20260726210000",
  "failedCheck": "applied_head_agreement",
  "checks": {
    "applied_head_agreement": {
      "ok": false,
      "code": "head_mismatch",
      "detail": "… expected=…, applied=…"
    }
  }
}
```

| `failedCheck` / code | Operator action |
|---|---|
| `database_reachability` | Check Supabase status, network, and `SUPABASE_SERVICE_ROLE_KEY` / URL env |
| `migration_head_discovery` | Ledger RPC missing or unreadable — do **not** treat as ready; restore service role + migrations |
| `applied_head_agreement` / `head_mismatch` | Repo/app expects a newer head than the DB. Plan a controlled migration apply (see #34 for production). **Never** auto-apply from readiness |
| `schema_contract` | Critical object missing — run clean replay on disposable DB; compare heads |
| `rpc_grants` | Privilege drift — review least-privilege migrations; do not casually `GRANT` status tokens |
| `patients_realtime_absent` | Drop `patients` from `supabase_realtime` (poll-only product) |
| `sms_ledger` | Apply migrations through the SMS ledger (#65) and later heads |
| `timeout` | DB too slow or stuck — investigate load; readiness budget is bounded |

## Clean replay (mandatory proof)

From an empty local database through **all** migrations and the full DB suite:

```bash
npm run test:db:replay
```

Equivalent:

```bash
npx supabase db reset --yes && npm run test:db
```

This is the only way to prove a green incremental DB is not masking migration order bugs. Do **not** run `db reset` against production.

## Read-only head comparison

```bash
npm run compare:migrations
# require local applied head:
npm run compare:migrations -- --require-local
# skip linked remote listing:
npm run compare:migrations -- --skip-linked
```

Compares repository files, `EXPECTED_MIGRATION_HEAD`, optional local applied ledger, and optional `supabase migration list` for a linked project. **Never** applies, repairs, or mutates production.

## Bumping the contract after a new migration

1. Add append-only SQL under `supabase/migrations/`.
2. Set `EXPECTED_MIGRATION_HEAD` in `src/lib/readiness-contract.ts` to the new version prefix.
3. If new runtime-critical objects/grants are required, extend the contract **and** `readiness_catalog_probe` in a new migration (do not edit old migrations).
4. `npm run test:db:replay` and `npm run compare:migrations -- --require-local`.

## Out of scope for readiness

- Browser/client proof that no Realtime subscription remains → **#56 / #72**
- Production migration apply / Auth dashboard cleanup → **#34**
- Auto-repair of linked ledgers

## Governance, Authority & Evidence (#73, #74)

- **Document Authority Precedence**: Resolved per `CONTEXT.md` § Document Authority Precedence. Remediation contracts (#56, #68, #72, #74) override historical specs.
- **Production Safety**: Production contains active camp operational data; **production is NEVER assumed to be empty**. `db reset` against production is prohibited.
- **Closure Evidence**: All readiness and migration verification output MUST satisfy the **[Issue #74](#74)** evidence contract.

