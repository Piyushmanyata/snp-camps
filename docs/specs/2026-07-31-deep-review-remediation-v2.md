# Spec — Deep Review Remediation v2 (2026-07-31)

> **Executor contract.** Every decision in this document is already made. You
> implement; you do not adjudicate. If something here appears to conflict with
> the codebase, **stop and report** — do not improvise an alternative. Do not
> widen scope. Do not "improve" anything not listed here.
>
> **Excluded by the requester:** MSG91 / SMS provider configuration
> (`MSG91_*` env vars and DLT template registration). That stays open. Every
> other item below must be closed.

---

## Problem Statement

The camp app is one week from running a live camp, and a full-stack review found
defects across three layers that the existing test suite does not catch:

1. **The repo cannot pass its own release gate.** `npm run lint` fails with 6
   errors and `npm run build` aborts while prerendering the public landing page.
   `npm run verify` therefore cannot complete, so no change can be certified.
2. **The database exposes retired attack surface.** Two obsolete registration
   RPC overloads are still `EXECUTE`-able by every signed-in staff session, and
   one of them is provably broken. The whole `persons` table — including the
   pepper-derived Aadhaar Person key that the application code says is "never
   returned to the browser" — is directly readable *and writable* by any
   volunteer through PostgREST.
3. **The readiness probe reports green while three of these problems are live.**
   The `register_rpc_supported_signatures_only` invariant is written to expect
   the stale overload, and `RATE_LIMIT_SECRET` — a hard fail-closed dependency
   for every patient-facing surface — is not checked at all. If it is unset in
   production, every `/s/<token>` status link returns 404 and
   `/api/health?ready=1` still answers `200 OK`.

There are also four smaller correctness / performance / robustness defects
listed in the Work Items.

## Solution

Close every defect in one branch, then prove closure with the four evidence
seams named in `AGENTS.md` (unit suite, `*.db.test.mjs`, Playwright e2e, and the
full `npm run verify` gate). Concretely:

- Make the lint and build gates pass again, without disabling a rule and without
  weakening the landing page.
- Add one append-only migration that drops the retired RPC overloads, closes the
  `persons` table to browser roles, repairs the false-green readiness invariant,
  and removes the dead `card_verified` predicates.
- Extend the readiness contract so `RATE_LIMIT_SECRET` and the new grant
  expectations are asserted, and bump the migration head on both sides.
- Align the two queue readers so FCFS order and count cost match.
- Harden the two under-validated API routes.

---

## User Stories

1. As a maintainer, I want `npm run lint` to exit 0, so that the first gate of `npm run verify` can run at all.
2. As a maintainer, I want the React Compiler to compile `clinical-desk.tsx` and `patient-form.tsx`, so that those two client islands are optimised like every other component instead of silently bailing out.
3. As a maintainer, I want `npm run build` to succeed even when the database is briefly unreachable, so that a transient Supabase blip cannot fail a production deploy.
4. As a patient visiting the landing page during a database outage, I want to see "No active camp right now" instead of an error page, so that I know the site works and can try again later.
5. As a security reviewer, I want exactly one `register_patient_idempotent` overload to exist, so that there is one enforced registration path and not three.
6. As a security reviewer, I want `register_patient_v2` gone, so that a broken, unreachable `SECURITY DEFINER` function is not left granted to `authenticated`.
7. As a security reviewer, I want the readiness probe to fail when a stale registration overload reappears, so that the invariant detects drift instead of blessing it.
8. As a Person whose Aadhaar was scanned, I want my `duplicate_key` to be unreadable by any browser session, so that the pepper-derived identity key behaves the way the code comments promise.
9. As a security reviewer, I want `persons` closed to `anon` and `authenticated` entirely, so that a volunteer cannot rewrite another Person's `duplicate_key` and break One-Person-per-Aadhaar.
10. As an operator, I want `/api/health?ready=1` to fail when `RATE_LIMIT_SECRET` is unset, so that I find out before patients do that every status link is 404ing.
11. As an operator, I want the readiness hint for a missing rate-limit secret to name the exact variable and the exact surfaces it breaks, so that I can fix it without reading source.
12. As a patient opening my status link, I want it to work whenever the app is healthy, so that a missing server secret is caught at deploy time, not by me.
13. As a volunteer watching the live queue, I want the order of two patients printed in the same second to stay stable across a refresh, so that I do not call the wrong person forward.
14. As a volunteer on a poor connection, I want the queue section retry to cost the database no more than the poll does, so that recovery is fast under camp-day load.
15. As an admin uploading a sponsor logo, I want an invalid camp to be rejected with a clear message before anything is stored, so that I am not told "Asset record failed" after a successful upload.
16. As a Team Lead completing a manual exception, I want an invalid camp day or gender to produce a specific message, so that I am not left with a generic "Manual registration failed. Try again."
17. As a maintainer, I want dead `provenance = 'card_verified'` predicates removed, so that a reader cannot mistake a no-op branch for a live guard.
18. As a maintainer, I want the unused `requireAdmin` helper deleted, so that no future route adopts the request-cached session path the same file warns against.
19. As a maintainer, I want the desk-live payload to select only the columns it returns, so that the select and the payload type cannot drift.
20. As a DBA, I want the `patients.manual_exception_actor` foreign key indexed, so that deactivating a Team Lead does not sequential-scan `patients`.
21. As an operator, I want Supabase Auth leaked-password protection enabled, so that staff cannot set a known-breached password.
22. As a maintainer, I want the database suite actually executed on this branch, so that "green" is a fact and not an assumption.
23. As a maintainer, I want each fix demonstrated failing before and passing after, so that the tests are proven to bind to the defect.

---

## Implementation Decisions

### Ordering

Do the work in the order below. Items W1–W2 come first because nothing can be
verified until the gates run.

---

### W1 — Fix the two lint failures (blocker)

**Evidence:** `npm run lint` currently exits non-zero with
`✖ 6 problems (6 errors, 0 warnings)`.

**W1a — `src/components/clinical-desk.tsx`**

Error: `86:12  error  Error: Cannot access variable before it is declared`
(`react-hooks` / React Compiler). The `useEffect` at lines 84–89 calls
`lookup(...)`, which is a hoisted `function` declaration further down the same
component body (around line 109). Hoisting makes this legal JavaScript, but the
compiler refuses to compile the component, so `ClinicalDesk` gets no
optimisation at all.

**Decision:** move the entire `useEffect` block (the one guarded by
`if (initialScan)`) so that it sits *after* the `lookup` function declaration
ends. Keep the existing `// eslint-disable-next-line react-hooks/exhaustive-deps`
comment and the `[initialScan]` dependency array exactly as they are. Change
nothing else in the file. Do **not** convert `lookup` to `useCallback` — that
would change identity semantics for every other caller in the component.

**W1b — `src/components/patient-form.tsx`**

Error, ×5: `158:5  error  Compilation Skipped: Existing memoization could not be
preserved` — the compiler infers `setGender`, `setAddress` and siblings as
dependencies of the `useCallback` at line 157 whose source dependency array is
`[]`.

**Decision:** delete the `useCallback` wrapper around `onCardScanned` and declare
it as a plain `const onCardScanned = async (parsed: ParsedAadhaarQr, diagnostic:
string): Promise<boolean> => { ... }` with the body unchanged. Remove the
trailing `, []` argument. If `useCallback` is no longer used anywhere else in the
file, remove it from the `react` import.

**Why this is safe (do not re-derive this — it is settled):**
`useAadhaarScanner` in `src/components/use-aadhaar-scanner.ts` stores the
callback in `onParsedRef` via a `useEffect` and only ever invokes
`onParsedRef.current(...)`. The hook never places `onParsed` in any dependency
array, so a new function identity on each render cannot restart the camera or
re-run any effect.

**Acceptance:** `npm run lint` exits 0 with no new `eslint-disable` comments
anywhere in the repo.

---

### W2 — Make the landing page degrade instead of failing the build (blocker)

**Evidence:** `npm run build` aborts with
`Error occurred prerendering page "/"` →
`Error: Active camp data could not be loaded` thrown at `src/lib/camp.ts:43`.

`src/lib/camp.ts` has two loaders, `fetchCachedSnapshot` and `fetchSnapshot`, and
both `throw new Error("Active camp data could not be loaded")` when the
`active_camp_snapshot` RPC returns an error. `/` is prerendered (Cache
Components is enabled), so the throw fails the whole production build.

**Decision:** both loaders must **return `null`** on RPC error after logging,
instead of throwing. `fetchCachedSnapshot` must also return `null` when
`createServiceRoleClient()` yields `null`, instead of throwing
`"Camp service is not configured"`.

Use exactly this logging shape (matches `logDbError` conventions elsewhere):

```
console.error("[camp] active camp snapshot failed", {
  code: error?.code,
  message: error?.message,
});
return null;
```

**Why this is safe (settled — do not re-derive):** all three call sites already
handle a `null` snapshot and render a correct empty state.

- `src/app/page.tsx` — renders "No active camp right now. Check back later, or ask staff." and disables the self-register action card.
- `src/app/self-register/page.tsx` — renders "Abhi koi Camp Day available nahi hai. Kripya baad mein try karein."
- `src/app/register/page.tsx` — `const days = camp?.days || []`.

Do **not** change any of those three pages. Do **not** add `force-dynamic` to
`/`. Do **not** add a new error boundary.

**Note on the local repro:** the build failure reproduces here because
`.env.local` points `NEXT_PUBLIC_SUPABASE_URL` at `http://127.0.0.1:54321` and
the local Supabase stack is not running (`ECONNREFUSED`). That is an
environmental trigger, but the defect is real: a page that a production build
must prerender has an unguarded live-database dependency. The fix is the
degradation above, not starting the local stack.

**Acceptance:** `npm run build` completes successfully **with the local Supabase
stack stopped**. Run it that way at least once, and paste that output as
evidence.

---

### W3 — One new migration: `supabase/migrations/20260731100000_deep_review_v2_remediation.sql`

Create exactly one new migration file with this version prefix. Append-only:
do **not** edit any existing migration file. The migration must be idempotent
enough to survive clean replay (`npm run test:db:replay`).

It must contain, in this order:

**W3.1 — Drop the two retired registration overloads.**

Current state, verified against the live project (`ruklmrzpyutvefancsgo`) with
`pg_proc`:

| Signature | Grants | Status |
|---|---|---|
| `register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean,boolean,text,text,date,text)` — 19 args | `authenticated, service_role` | **current, keep** |
| `register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean)` — 14 args | `authenticated, service_role` | **drop** |
| `register_patient_v2(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean,text)` — 15 args | `authenticated, service_role` | **drop** |

Both are legacy forwarders left behind by
`20260727220000_person_scanned_registration_migration.sql`, which deliberately
kept short forwarders. They are no longer deliberate:

- **No application code calls either one.** The only two callers of the RPC are
  `src/app/api/desk/register-scanned/route.ts` and
  `src/app/api/self-registration/route.ts` (plus
  `staffRegistrationRpcArgs` in `src/lib/registration-request.ts`), and all
  three send the full 19 named parameters, which PostgREST resolves to the
  19-argument overload.
- **`register_patient_v2` is provably broken.** Its body calls
  `register_patient_idempotent(..., false, null::text, null::timestamptz,
  null::text, p_provenance)` — an argument list of
  `(...,boolean,text,timestamptz,text,text)`. `to_regprocedure` on that
  signature returns `NULL`, and `pg_cast` contains **no** entry from
  `timestamptz` to `text`, so no implicit cast can rescue resolution. Every call
  raises `function ... does not exist`. It is dead code holding an EXECUTE grant.
- The 14-argument forwarder passes `p_duplicate_key => NULL`,
  `p_date_of_birth => NULL` and `p_provenance => 'self_declared'`, so it is a
  live path that can never mint a Person and never enforces the scanned-identity
  branch. It is a second, weaker door onto the same table.

Use `DROP FUNCTION IF EXISTS` with the **exact** signatures above. Dropping a
function touches no rows and is safe against live camp data.

**W3.2 — Close `public.persons` to browser roles.**

Current state: `persons` grants `SELECT`, `INSERT` and `UPDATE` on **all**
columns — including `duplicate_key`, `aadhaar_locked_at` and `name_locked_at` —
to `authenticated`, backed by three RLS policies (`staff read persons`,
`staff insert persons`, `staff update persons`), all predicated on
`is_staff() OR is_admin()`.

This contradicts the boundary the code documents. `src/app/api/desk/register-scanned/route.ts`
states: *"The Aadhaar Person key is derived only on the server and is never
returned to the browser."* It is currently one PostgREST `GET
/rest/v1/persons?select=duplicate_key` away from any signed-in volunteer, next
to `aadhaar_last4`, `date_of_birth`, `full_name` and `gender` — the exact four
inputs the key is derived from. Worse, `enforce_person_field_locks()` guards
`aadhaar_last4`, `full_name`, `date_of_birth` and `gender` but **not**
`duplicate_key`, so a volunteer can null or rewrite it and defeat
One-Person-per-Aadhaar globally.

**Decision:** `persons` is a server-only table.

- `REVOKE ALL ON TABLE public.persons FROM anon, authenticated;`
- `DROP POLICY IF EXISTS` for all three policies named above.
- Leave RLS **enabled** on the table.
- Leave `service_role` privileges untouched.

**Why this is safe (settled):** a repo-wide search for `.from("persons")` across
`src/` returns **zero** matches. Every read and write of `persons` goes through
`SECURITY DEFINER` RPCs (`register_patient_idempotent`, `lookup_patient_status_token`,
`ensure_patient_person_id`, the clinical RPCs), which run as the function owner
and are unaffected by table grants or RLS policies.

**W3.3 — Add an index for the unindexed foreign key.**

```
CREATE INDEX IF NOT EXISTS patients_manual_exception_actor_idx
  ON public.patients (manual_exception_actor)
  WHERE manual_exception_actor IS NOT NULL;
```

Reported by the Supabase performance linter
(`unindexed_foreign_keys` on `patients_manual_exception_actor_fkey`).

**W3.4 — Remove the dead `card_verified` predicates.**

The `patients.provenance` CHECK constraint now allows only
`('self_declared', 'card_scanned', 'manual_exception')` (set by
`20260730040210_issue_124_workflows.sql`). The value `card_verified` was renamed
away by `20260728115000_rename_scanned_and_phone_provenance.sql`, but
`20260729075022_retire_active_admin_controls.sql` re-introduced it, and three
live routines still test for it:

- `public.claim_sms_delivery(uuid, sms_delivery_kind, text, integer)`
- `public.patient_registration_notify_fields(uuid)`
- `public.reject_self_registration_delivery()` (trigger on `sms_deliveries`)

The predicate `p.created_by IS NULL AND p.provenance = 'card_verified'` can never
be true. It reads as a live self-registration guard and is not one.

**Decision:** the authoritative marker for a self-registration is
`created_by IS NULL`. Provenance is orthogonal to it. Rewrite all three routines
with `CREATE OR REPLACE FUNCTION`, preserving every other line of their bodies,
their `LANGUAGE`, volatility, `SECURITY DEFINER`, `SET search_path` and their
existing grants, changing only:

- In `claim_sms_delivery`: replace the whole first `OR` branch
  `(p.created_by IS NULL AND p.provenance = 'card_verified')` with
  `(p.created_by IS NULL)`. Leave the second branch
  `(d.day_date IS NOT NULL AND (p.created_by IS NULL OR d.day_date <= (timezone('Asia/Kolkata', now()))::date))`
  exactly as it is — **same-day desk registrations are intentionally excluded
  from the registration SMS** (see the header comment in
  `20260729075022_retire_active_admin_controls.sql`); this is not a bug, do not
  "fix" it.
- In `patient_registration_notify_fields`: change
  `AND NOT (p.created_by IS NULL AND p.provenance = 'card_verified')` to
  `AND p.created_by IS NOT NULL`.
- In `reject_self_registration_delivery`: change the `EXISTS` predicate to
  `p.id = NEW.patient_id AND p.created_by IS NULL`.

After each `CREATE OR REPLACE`, re-issue the same `REVOKE`/`GRANT` statements
those functions already carry. `CREATE OR REPLACE` on an identical signature
preserves grants, but re-issuing them is cheap insurance and `AGENTS.md`
requires you to check `pg_proc` afterwards.

**W3.5 — Repair the false-green readiness invariant and add two new facts.**

`readiness_catalog_probe()` currently computes
`register_rpc_supported_signatures_only` as:

```
select count(*) = 2 ... where p.proname = 'register_patient_idempotent'
```

It asserts that the stale overload **is** present. It also ignores
`register_patient_v2` entirely. That is why the probe reports every invariant
`true` while W3.1 is live.

**Decision:** replace `readiness_catalog_probe()` wholesale with
`CREATE OR REPLACE FUNCTION` (it takes no arguments and returns `jsonb`, so
replacement is signature-safe), changing exactly three things and copying
everything else verbatim from `pg_get_functiondef`:

1. `register_rpc_supported_signatures_only` becomes true only when **all** of:
   - exactly **one** `public.register_patient_idempotent` exists in `pg_proc`;
   - **no** `public.register_patient_v2` exists in `pg_proc`;
   - the surviving overload's `pg_get_function_arguments` contains none of
     `aadhaar_hash`, `aadhaar_verified_at`, `aadhaar_kyc_ref` (keep the existing
     three `not ilike` checks unchanged).
2. Add two new keys to the `grants` object:
   - `persons_authenticated_select` — must be `false`. Compute with
     `has_table_privilege('authenticated', 'public.persons', 'SELECT')`.
   - `persons_authenticated_write` — must be `false`. Compute as
     `has_table_privilege('authenticated', 'public.persons', 'INSERT')
      OR has_table_privilege('authenticated', 'public.persons', 'UPDATE')`.
3. Bump the migration-head anchor from `'20260731090000'` to `'20260731100000'`.

Re-issue `ALTER FUNCTION public.readiness_catalog_probe() OWNER TO postgres;`
and the existing `REVOKE`/`GRANT ... TO service_role` after replacement.

Do **not** reuse the `pg_get_functiondef` + `replace()` + `EXECUTE` trick that
`20260731090000` used for the head bump. Write the full function body out. That
trick is brittle against whitespace drift and is exactly why the previous
migration had to `RAISE EXCEPTION 'anchor not found'`.

**W3.6 — Verification block at the end of the migration.**

End the file with a `DO $$ ... $$;` block that `RAISE EXCEPTION`s if any of the
following is false. This is the drift tripwire that must survive replay:

- `count(*) = 1` for `pg_proc` rows named `register_patient_idempotent` in `public`.
- `to_regprocedure('public.register_patient_v2(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean,text)') IS NULL`.
- `has_table_privilege('authenticated', 'public.persons', 'SELECT') = false`.
- `has_table_privilege('authenticated', 'public.persons', 'INSERT') = false`.
- `has_table_privilege('authenticated', 'public.persons', 'UPDATE') = false`.
- `public.latest_applied_migration() = '20260731100000'` is what the probe now anchors on.
- No routine in `public` whose `pg_get_functiondef` contains the literal `card_verified`.

---

### W4 — Readiness contract: assert `RATE_LIMIT_SECRET`

**Evidence:** `src/lib/distributed-rate-limit.ts` returns
`{ allowed: false, unavailable: true }` when `RATE_LIMIT_SECRET` is empty — a
deliberate fail-closed with an explicit "never fall back to the service-role key"
comment. The consequences when it is unset in production:

| Surface | Behaviour |
|---|---|
| `/s/<token>` (`src/app/s/[token]/page.tsx`) | `notFound()` — every patient status link 404s, indistinguishable from a bad token |
| `POST /api/lookup` | 503 with the generic Hinglish mismatch message |
| `POST /api/self-registration` | 503 "Self-registration abhi available nahi hai" |
| `GET /api/health?ready=1` | **200 OK** |

`integrationConfig()` in `src/lib/readiness.ts` checks `MSG91_*`,
`AADHAAR_HASH_PEPPER` and `CRON_SECRET`, but not `RATE_LIMIT_SECRET`. The
`required_configuration` check therefore cannot fail on it. `scripts/check-env.mjs`
only proves the variable is *documented* in `.env.example`; it never checks that
anything is *set*.

**Decisions:**

1. In `src/lib/readiness.ts`, add `rateLimitSecret: Boolean(env.RATE_LIMIT_SECRET?.trim())`
   to the object returned by `integrationConfig()`, and add the matching
   `rateLimitSecret: boolean` field to the `integrations` type at the top of the
   file.
2. Make the `required_configuration` check fail (not warn) when
   `rateLimitSecret` is false, using the same `fail(...)` helper and code shape
   already used for the Aadhaar pepper. `AADHAAR_HASH_PEPPER` keeps its existing
   behaviour; the two are independent required-configuration facts and the check
   fails if either is missing.
3. In `src/lib/readiness-contract.ts`, extend
   `CHECK_OPERATOR_HINTS.required_configuration` so it also names the rate-limit
   secret. Use exactly:

   > `AADHAAR_HASH_PEPPER is required for stable Person identity, and RATE_LIMIT_SECRET is required for durable public rate limiting. Without RATE_LIMIT_SECRET every /s/<token> status link returns 404 and self-registration and patient lookup fail closed. Configure the existing production values; never rotate the pepper during an active Camp.`

4. In `src/lib/readiness-contract.ts`, bump `EXPECTED_MIGRATION_HEAD` from
   `"20260731090000"` to `"20260731100000"`, and bump
   `READINESS_CONTRACT_VERSION` from `5` to `6`.
5. In `src/lib/readiness-contract.ts`, add to `GRANT_EXPECTATIONS`:
   `persons_authenticated_select: false` and `persons_authenticated_write: false`
   (matching the two new probe facts from W3.5), each with a one-line comment
   explaining that `persons` is server-only because `duplicate_key` is the
   pepper-derived Person key.

`RATE_LIMIT_SECRET` is already documented in `.env.example`, so `npm run check:env`
needs no change.

---

### W5 — Align the two queue readers

Two code paths render the same waiting list with different contracts:

- `src/app/api/desk/live/route.ts` orders by `queued_at ASC NULLS LAST`, then
  `reg_no ASC`, then `id ASC` — the documented FCFS tie-break — and deliberately
  avoids an exact `COUNT` unless the queue exceeds `DESK_LIVE_WAITING_LIMIT`
  (100), fetching `limit + 1` and inferring instead.
- `loadQueueSection` in `src/lib/section-reads.ts` orders by `queued_at` **only**
  and passes `{ count: "exact" }` on every call.

Consequences: two patients printed in the same millisecond can swap places
between the server-rendered page / section retry and the next poll; and the
section path pays a full exact count on a table that is being written to
continuously during camp day.

**Decisions:**

1. Add `.order("reg_no", { ascending: true })` and `.order("id", { ascending: true })`
   after the existing `queued_at` order in `loadQueueSection`, matching the
   desk-live route exactly.
2. Replace `{ count: "exact" }` in `loadQueueSection` with the desk-live
   strategy: select without a count, `.limit(101)`, slice to 100, and only issue
   a separate `select("id", { count: "exact", head: true })` when more than 100
   rows came back. Keep returning the same `QueueSectionData` shape
   (`{ waiting, waitingTotal }`) — the client contract does not change.
3. In `src/lib/desk-live.ts`, remove `queued_at` from `DESK_LIVE_WAITING_SELECT`
   so it reads `"id, reg_no, full_name, phone"`. The desk-live route already
   drops that column when building `DeskLiveWaitingRow`, and the type does not
   declare it. `loadQueueSection` keeps selecting `queued_at` because
   `WaitingRow` declares it as optional and it must remain in the `ORDER BY`.

Extract the shared limit constant only if it is already exported — it is:
`DESK_LIVE_WAITING_LIMIT` from `src/lib/desk-live.ts`. Import and use it in
`section-reads.ts` rather than writing a second `100`.

---

### W6 — Input validation on two routes

**W6a — `src/app/api/admin/sponsor-assets/route.ts` (`POST`)**

`const campId = String(form.get("campId") ?? "")` is passed straight into the
storage object key (`${campId}/${id}.${extension}`) and then into the
`sponsor_assets` insert. An absent or malformed `campId` uploads an object to a
garbage prefix and only fails afterwards on the foreign key, returning
`"Asset record failed."` (500) for what is a client error.

**Decision:** after the admin guard and before the `file` checks, validate
`campId` against the same UUID regex used elsewhere in the repo, and confirm the
camp exists:

```
if (!isPatientUuid(campId)) → 400 { error: "Select a camp before uploading." }
```

then, using the service-role client, `from("camps").select("id").eq("id", campId).maybeSingle()`
and return `400 { error: "Select a camp before uploading." }` when it is absent.
Import `isPatientUuid` from `@/lib/qr` — it is the repo's existing UUID
validator and is already used for this purpose in
`src/app/api/desk/live/route.ts` and `src/app/api/desk/section/route.ts`.
Do not add a new regex.

**W6b — `src/app/api/desk/register-manual/route.ts` (`POST`)**

`requestId`, `campId` and `campDayId` are forwarded as bare trimmed strings;
`age` is `Number(body.age)` with no integer check; `gender` is passed through
with no `M`/`F`/`O` constraint. Every one of these currently surfaces as the
generic `"Manual registration failed. Try again."` (409).

**Decision:** mirror the validation already present in
`src/app/api/desk/register-scanned/route.ts`. Before calling the RPC, reject
with `400` and a specific message when:

- `requestId`, `campId` or `campDayId` fails `isPatientUuid` →
  `"Registration session is invalid. Reload the desk and try again."`
- `gender` (uppercased) is not one of `M`, `F`, `O` →
  `"Select M, F or O."`
- `age` is not an integer in `[0, 149]` → `"Enter an age between 0 and 149."`
- `fullName` is empty → `"Enter the patient's full name."`

Keep the existing `fail(message, status)` helper and response envelope
(`{ data: null, error: { message } }`) — the client parses that shape.

---

### W7 — Delete the unused `requireAdmin` helper

`src/lib/auth.ts` exports `requireAdmin()`, which calls the React-cached
`getSessionProfile()`. The same file's own documentation, ten lines above, says
route handlers must prefer the uncached `loadSessionProfile()` so that role
checks are not pinned to a request-scoped cache entry from an earlier call.

A repo-wide search shows **no importer**. It is dead code that models the wrong
pattern for whoever adds the next admin route.

**Decision:** delete the `requireAdmin` function. Remove the now-unused
`NextResponse` import from `src/lib/auth.ts` if nothing else in the file uses it.
Do not replace it with a corrected version — every existing admin route already
inlines `loadSessionProfile()` plus a role check, and that is the pattern to
keep.

---

### W8 — Manual operations item (not code)

Supabase Auth **leaked-password protection is disabled** on project
`ruklmrzpyutvefancsgo` (Supabase security advisor, `auth_leaked_password_protection`,
WARN). Staff passwords are minted by `generateTemporaryPassword()` and then
changed by the user, so a breached password can currently be set.

This cannot be changed by a migration. Record it in the branch's completion
report as an operator action with these exact steps: Supabase Dashboard →
Authentication → Policies (Password settings) → enable "Prevent use of leaked
passwords". Do **not** attempt it through the MCP tools or the CLI.

---

### Explicitly reviewed and confirmed correct — do not change

These were examined during the review and are working as designed. Changing them
is out of scope and will be treated as a regression:

- `active_camp_snapshot()` being `EXECUTE`-able by `anon`. The public landing
  page and `/self-register` need it, and it returns only camp name, venue, date
  and per-day seat counts — no PII, no patient rows.
- Same-day desk registrations receiving no registration SMS
  (`enforce_registration_sms_eligibility` and the second branch of
  `claim_sms_delivery`). Intentional per `20260729075022`.
- The 9 tables with RLS enabled and no policies (`sms_deliveries`,
  `public_rate_limit_buckets`, `sponsor_assets`, the clinical tables). RLS with
  no policy denies all browser access, which is the intent; `service_role`
  bypasses RLS. Supabase reports these at INFO level only.
- `patients` having no `INSERT`/`UPDATE` RLS policy for `authenticated`. All
  writes go through `SECURITY DEFINER` RPCs.
- `authorizeCron` comparing secret lengths before `timingSafeEqual`.
- `register-scanned` returning the raw `AADHAAR_DUPLICATE:reg=N` message to the
  client. The desk form parses it, and it is staff-only.
- The `unused_index` performance advisories. The project holds test data only,
  so zero index usage proves nothing.

---

## Testing Decisions

**What makes a good test here.** Assert observable behaviour at a seam the
application actually uses — an HTTP response, an RPC result, a catalog fact, a
rendered page. `AGENTS.md` is explicit that source-text regex assertions are
discouraged: they break on rename and pass on rot. It is equally explicit that
**a skipped database test is a failure**, and that a guard which treats a missing
RPC as "Postgres unavailable" silently deletes coverage exactly when a migration
breaks something. Do not write one.

**Prefer existing seams.** Every test below belongs in a file that already
exists. Do not create a new test file unless the table below says to.

| Work item | Seam | File |
|---|---|---|
| W1a, W1b | `npm run lint` exit code | none — gate output is the evidence |
| W2 | `npm run build` with the DB unreachable | none — gate output is the evidence |
| W3.1 | `pg_proc` catalog, via DB test | `tests/security-invariants.test.mjs` if it has DB access, otherwise `tests/adversarial-remediation.db.test.mjs` |
| W3.2 | `has_table_privilege` on `persons`, plus an authenticated PostgREST read that must be denied | `tests/patient-read-boundary.db.test.mjs` |
| W3.4 | no routine in `public` contains `card_verified` | `tests/adversarial-remediation.db.test.mjs` |
| W3.5, W4 | `readiness_catalog_probe()` output and `evaluateReadiness()` | `tests/ops-readiness.db.test.mjs` and `tests/ops-readiness.test.mjs` |
| W5 | `loadQueueSection` result order and query shape | `tests/section-isolation.test.mjs` |
| W6a, W6b | route handler responses via the existing route loader | `tests/admin-staff.route.test.mjs` pattern; add cases to `tests/desk-register-scanned.route.test.mjs` for W6b |
| W7 | none — deletion is proven by `npx tsc --noEmit` and lint |

**Specific tests to add:**

1. **Registration overload uniqueness (DB).** Query `pg_proc` and assert exactly
   one `register_patient_idempotent` and zero `register_patient_v2` in `public`.
   Assert `has_function_privilege('authenticated', ...)` is false for the
   dropped signatures by asserting `to_regprocedure(...) IS NULL`.
2. **Persons is server-only (DB).** Assert all three of
   `has_table_privilege('authenticated','public.persons', 'SELECT'|'INSERT'|'UPDATE')`
   are false. Then, using the real-role mechanism
   `tests/patient-read-boundary.db.test.mjs` already uses — a direct `pg` client
   with `SET LOCAL ROLE authenticated` plus `request.jwt.claims` set to a seeded
   volunteer — attempt `select duplicate_key from public.persons` inside a
   rolled-back transaction and assert it raises `42501` (permission denied). The
   privilege-only assertion is not sufficient on its own; assert the actual
   denial.

   While you are in that file, note that its `connect()` helper treats a missing
   `public.patients` table as "database unavailable". Leave the helper alone —
   `scripts/run-db-tests.mjs` fails the run on any skip, which contains the
   risk — but do **not** copy that pattern into any new guard you write.
3. **Readiness fails without the rate-limit secret (unit).** Call
   `integrationConfig({ AADHAAR_HASH_PEPPER: "x" })` and assert
   `rateLimitSecret === false`; call `evaluateReadiness` with a stub client and
   an env lacking `RATE_LIMIT_SECRET`, and assert the response is `ok: false`
   with `failedCheck === "required_configuration"` and HTTP 503. Assert the
   returned detail contains the literal `RATE_LIMIT_SECRET` and no secret value.
4. **Readiness invariant now detects a stale overload (DB).** Assert
   `readiness_catalog_probe()` reports `register_rpc_supported_signatures_only`
   true after the migration, and that
   `grants.persons_authenticated_select` and `grants.persons_authenticated_write`
   are both `false`. Assert `EXPECTED_MIGRATION_HEAD` equals
   `latest_applied_migration()`.
5. **FCFS tie-break (unit, with a stubbed Supabase client).** Assert
   `loadQueueSection` issues `queued_at`, `reg_no`, `id` orders in that sequence,
   and that it does **not** request `count: "exact"` when 100 or fewer rows come
   back, and **does** when 101 come back. The existing stub style in
   `tests/section-isolation.test.mjs` is the prior art.
6. **Route validation (unit, route loader).** For W6a: `POST` with a missing and
   a non-UUID `campId` returns 400 and never touches storage. For W6b: `POST`
   with a non-UUID `campDayId`, with `gender: "X"`, and with `age: 200` each
   return 400 with the specified message and never call the RPC.
7. **Landing page degradation (unit).** Assert that `getActiveCampSnapshot`
   resolves to `null` rather than rejecting when the injected RPC returns an
   error. If `camp.ts` has no injection seam today, add the smallest one — an
   optional client parameter defaulting to the existing factory — rather than
   mocking modules.

**Red/green discipline.** `AGENTS.md` requires it: for each of items 1–7, show
the test failing against the pre-fix state and passing after. Capture both
outputs. Do not claim a suite passed without pasting the terminal output, and
report skip counts explicitly.

**Known state of the suites at the time this spec was written:**

- `npx tsc --noEmit` — passes (exit 0).
- `npm test` — 384 tests, 374 pass, 0 fail, **10 skipped**. All 10 skips are the
  Postgres-dependent stress cases in `tests/empirical-challenge.test.mjs` and
  `tests/empirical-challenge-m3-1.test.mjs`, which skip because the local
  Supabase stack was not running.
- `npm run lint` — **fails**, 6 errors (W1).
- `npm run build` — **fails** while prerendering `/` (W2).
- `npm run test:db` — **not run**; Docker Desktop was not running, so the local
  Supabase stack could not be started.

The database suite has therefore not been executed against these changes by
anyone. Running it is a hard requirement of Definition of Done, not an optional
extra.

---

## Out of Scope

- **MSG91 / SMS provider configuration.** `MSG91_AUTH_KEY`, `MSG91_SENDER_ID`,
  `MSG91_DLT_TE_ID_REGISTRATION`, `MSG91_DLT_TE_ID_REMINDER`,
  `MSG91_TEMPLATE_REGISTRATION`, `MSG91_TEMPLATE_REMINDER` and DLT template
  registration stay open by explicit instruction. Do not add them to the
  readiness required-configuration check, do not change `isMsg91Configured()`,
  and do not alter the "skipped: unconfigured" degradation paths in
  `src/app/api/notify/registration/route.ts` or `src/lib/reminder-sms.ts`.
- Any new feature, screen, desk action, or clinical field. The desk has exactly
  two actions and `AGENTS.md` says to question a third — this branch adds none.
- Re-designing the SMS suppression rules. W3.4 removes a dead predicate; it does
  not change which patients receive SMS.
- Changing `style-src 'unsafe-inline'` in `src/lib/csp.ts`. Explicitly out of
  scope per the comment in that file.
- Dropping unused indexes reported by the Supabase performance advisor.
- Enum cleanup. `user_role` still lists `doctor` and `patient`; a value cannot be
  dropped from a Postgres enum.
- Any migration that removes data. `AGENTS.md`: once real camp data exists,
  removals must archive rather than drop.

---

## Further Notes

**Migration safety rules that apply to W3, from `AGENTS.md`:**

- Append-only. Never edit an existing migration file. Never run `db reset`
  against production.
- Changing a function's argument list creates a **new overload** rather than
  replacing the old one; `CREATE OR REPLACE` cannot change a return type at all.
  When either changes, `DROP` the exact old signature explicitly and re-`GRANT` —
  a dropped-and-recreated function loses its grants, and a forked overload leaves
  the old one live. **Check `pg_proc` afterwards.** This branch exists largely
  because that rule was not followed twice before.
- Preserve `FOR UPDATE` lock order and capacity guards in any RPC you touch. You
  are not touching `upsert_camp_day` or `register_patient_idempotent`'s body in
  this branch — keep it that way.

**Validate with clean replay:** `npm run test:db:replay` runs
`npx supabase db reset --yes` against the **local disposable** database and then
the DB suite. Requires Docker Desktop running. This is the only sanctioned way
to prove the new migration replays.

**Do not apply the migration to the remote project yourself.** Land the file,
prove it with local clean replay, and leave production application to the
operator.

**Definition of Done.** All of the following, with terminal output pasted into
the completion report:

1. `npm run lint` — exit 0.
2. `npx tsc --noEmit` — exit 0.
3. `npm test` — 0 failures, **0 skips** (start the local Supabase stack so the 10
   currently-skipped Postgres cases actually run; report the count explicitly).
4. `npm run test:db` — 0 failures, 0 skips.
5. `npm run test:db:replay` — clean replay of all 75 migrations succeeds.
6. `npm run build` — succeeds **with the local Supabase stack stopped** (this is
   the W2 acceptance test; run it separately from the `verify` pass).
7. `npm run check:js-budget` — within budget, no regression.
8. `npm run test:e2e` — passes.
9. `npm run check:env` — passes.
10. `npm run verify` — the whole gate, end to end, exit 0.
11. `npm run compare:migrations` — repository head and applied head agree at
    `20260731100000`.
12. Red/green artifacts for tests 1–7 in Testing Decisions.
13. A statement of which manual operator action (W8) remains outstanding.

**A green suite is not evidence the app works.** `AGENTS.md` records that every
defect found in the July 2026 audit passed the full suite, and this review found
two gate failures and a false-green readiness invariant that 374 passing tests
did not catch. After the gates pass, start the app and confirm by hand: the
landing page renders with the database up and with it down; a `/s/<token>` link
resolves; the volunteer desk queue order is stable across a manual refresh.
