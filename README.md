# SNP Camps

Simple medical camp desk for **Sikar Nagarik Parishad (Kolkata)**.

The app tracks a queue. **The printed prescription is the clinical record** — no
diagnosis, medicine or treatment data is stored. See
[`docs/adr/0008-printing-queues-the-patient.md`](docs/adr/0008-printing-queues-the-patient.md).

## Camp flow

1. **Registration**
   - **Desk (staff):** Full name + age required; phone, Aadhaar last-4, gender, address optional. Scanning the card's QR fills the form and locks the identity fields.
   - **Self-registration (patient):** Patient scans the QR on their own Aadhaar card at `/self-register`. **No OTP, no eKYC provider, no registration SMS** — the confirmation screen (reg number, patient QR, camp day, venue, status link) is the receipt. Queue status is **always `registered`**, never `waiting`. Needs only `AADHAAR_HASH_PEPPER`.
2. **Print prescription** → scan the patient QR or type the reg number. **Printing is what puts them in the queue** (`registered` → `waiting`). Line order is by print time. A reprint keeps their original place and never re-queues them.
3. The doctor writes on the printed form by hand. The app is not involved.
4. **Mark seen** → scan, type, or tap the live queue. Records the time and the volunteer who scanned. A double scan is a no-op; a mis-scan can be undone for ten minutes.
5. **Patient status (passwordless):** `/s/<token>` with no sign-in.

Seat caps apply to **pre-registration only** — a walk-in at the desk is never turned away.

- Patient QR is for **staff scan only** (payload `/p/{uuid}` or `snp:{uuid}` — never a login)
- One active camp; FCFS queue = **`waiting` only** (physically present)
- Aadhaar: full number used only for parsing in memory; **last 4 digits only** stored

## Auth model

**Staff** (admin, team lead, volunteer) sign in with email + password at `/login`.
There is no doctor login role — see ADR 0008.

**Patients** do not authenticate. Self-registration needs no OTP and creates no
account or session; the Aadhaar card QR is parsed offline and assumed authentic (see
[`docs/adr/0004-aadhaar-parsed-not-verified.md`](docs/adr/0004-aadhaar-parsed-not-verified.md)).
Status tracking is passwordless via `/s/<token>`. The former desk-slip passcode +
phone-OTP model is **superseded** (see
[`docs/adr/0001-passcode-on-desk-slip.md`](docs/adr/0001-passcode-on-desk-slip.md)).
Any future change to this model updates `README.md`, `CONTEXT.md`, and a new or
amended ADR together — or none of them.

## Document Authority Precedence

1. **`docs/adr/`** — architectural decision records (ADR 0008 defines the current architecture).
2. **`CONTEXT.md`** — ubiquitous language, domain context, lifecycle invariants, role boundaries.
3. **`README.md`** — operations, deployment, build/verify gates, auth model, MSG91 configuration.

## Production Safety

**Production is NEVER assumed to be empty.**
- Running `db reset` or re-applying baseline SQL against production is strictly prohibited.
- Schema changes must be applied via append-only incremental migrations under `supabase/migrations/` and validated through clean replay on disposable databases.
- Public patient Realtime channels are retired; `patients` is strictly absent from `supabase_realtime`.

Migration `20260728119000` dropped the retired clinical tables irreversibly. That was
a one-time exception, authorised while production held test data only. It sets no
precedent — once real camp data exists, removals must archive rather than drop.

## Stack

Next.js · Supabase · Vercel · GitHub: [Piyushmanyata/snp-camps](https://github.com/Piyushmanyata/snp-camps)

## Setup

### 1. Database schema (Supabase CLI)

Schema lives only under `supabase/migrations/`. There is one **baseline** migration
that reproduces the full current schema on an empty database, plus later incremental
files. The CLI keeps the migration ledger.

**Baseline is append-never.** Do not edit `supabase/migrations/*_baseline_*.sql` after
it is committed. Every schema change is a new file from
`npx supabase migration new <descriptive_name>`. Hand-editing the baseline is how the
ledger and production drift apart.

**Before any `db push`:** run `npx supabase migration list` against the linked project
and confirm every local file has a definite remote status (applied or pending). If the
remote column is empty for a file that already exists in production (e.g. after a
squash), repair the ledger with
`npx supabase migration repair --status applied <version>` — that writes a history row
only and **does not** execute SQL. Never treat an empty remote column as "safe to push."

**Empty project (local or new remote):**

```bash
npx supabase start          # local Docker stack (optional)
npx supabase db reset       # apply all local migrations on a clean DB
```

Do **not** re-run the baseline against a database that already has this schema. Do
**not** run `db reset` against production.

**How to change the schema:**

1. `npx supabase migration new <descriptive_name>` — creates an empty SQL file with a CLI timestamp.
2. Write the incremental SQL in that file (prefer reversible, small steps).
3. Apply and verify on a disposable DB first: `npm run test:db:replay`.
4. Bump `EXPECTED_MIGRATION_HEAD` in `src/lib/readiness-contract.ts` **and** the `migration_head_current` invariant inside `readiness_catalog_probe()`. Readiness fails closed if they disagree with the applied head.
5. Commit the migration file. Never hardcode a project ref or scrape passwords from `.env.local` — use `supabase link` / documented env vars.

Queue and seat boards use **manual Refresh** or a **fixed poll** — no live websockets.

`GET /api/health` is a cheap, open **liveness** probe (no database).
`GET /api/health?ready=1` is **fail-closed readiness**: database reachability,
migration-head discovery, applied-head agreement with the versioned runtime contract
(`src/lib/readiness-contract.ts`), schema/RPC/grant catalog facts, absence of
`patients` from Realtime, and durable SMS ledger. Any discovery failure, timeout, or
mismatch returns **HTTP 503**. Output names the failed check and expected migration
id; it never includes secrets, SQL text, PHI, or connection strings. The readiness
path is per-IP rate-limited (12/min). Liveness stays independent of readiness.

Operator guide: [`docs/ops-readiness.md`](docs/ops-readiness.md).

**Clean replay** (empty local DB → all migrations → full DB suite):

```bash
npm run test:db:replay
```

**Read-only head comparison** (never applies or repairs):

```bash
npm run compare:migrations
```

### 2. Auth settings

- **Email**: enable the Email provider (staff only: admin, team lead, volunteer). Patient app login and password auth are **not** used. Patient self-registration (`/self-register`) needs no Auth user, no OTP and no provider — it is an offline Aadhaar card scan.

### 3. Env

Copy `.env.example` → `.env.local`.

```
SUPABASE_SERVICE_ROLE_KEY=...   # server-only; never expose with NEXT_PUBLIC_
```

Bootstrap the first admin once. Set `SUPABASE_PROJECT_REF`,
`ADMIN_BOOTSTRAP_EMAIL`, and a unique `ADMIN_BOOTSTRAP_PASSWORD` of at least 14
characters, then run `npm run bootstrap:admin`. Remove those three bootstrap values
immediately after it succeeds. All later staff are created by an active admin; there
is no public staff self-registration route.

Required for scanner registration:

```
# Aadhaar card scan — HMAC secret for the Person duplicate key.
# Readiness fails closed without it. Never rotate during an active camp.
# AADHAAR_HASH_PEPPER=…
```

`npm run check:env` fails the build if any `process.env` read in `src/` or `scripts/`
is missing from `.env.example`. Document new variables there as you add them.

> **Local dev note:** `.env.example` sets `NEXT_PUBLIC_SITE_URL` to the production
> URL, so QR codes generated in local dev point at production. Override it locally
> when testing scan flows end to end.

### 4. Local

```bash
npm install
npm run dev
```

1. Sign in at `/login` with the bootstrapped admin.
2. Create a camp and set it active.
3. Add volunteers and team leads from the admin desk.
4. Register walk-ins from the desk; scan the physical Aadhaar QR for offline auto-fill, or enter details manually.

### 5. Deploy Vercel

```bash
npx vercel
```

Add the same env vars in Vercel. Set `NEXT_PUBLIC_SITE_URL` to the production URL (for
QR links), and `CRON_SECRET` (the nightly reminder job rejects itself without it).

## Verification

```bash
npm run verify
```

Runs, in order: lint → `tsc --noEmit` → unit → DB → production build → JS budget →
e2e → env check. Treat these as the gate, not as diagnostics.

Two rules that have caught real regressions here:

1. **A skipped DB test is a failure, not a pass.** `npm run test:db` prints its skip count and fails the run on any skip. Test files may skip only when the database is genuinely unreachable — a guard that treats a *missing RPC* as "Postgres unavailable" deletes coverage exactly when a migration breaks something.
2. **A green suite is not evidence the app works.** Every defect found in the July 2026 audit passed the full suite. Verify against a running app.

For a bug fix, show the test failing before the fix and passing after.

Run load tests only against a production-like staging deployment:

```bash
LOAD_BASE_URL=https://staging.example.com npm run load:smoke
```

The harness is read-only by default. More than 100 virtual users requires
`ALLOW_HIGH_LOAD=true`; coordinate a 5,000-VU test with Supabase/Vercel first. Use
realistic think time and seeded data, and require under 1% errors with p95 below 1.5
seconds before treating the result as a capacity signal.

## Roles

| Role | Access |
|------|--------|
| Admin | Camps, days, staff, search, counts, camp settings, the same desk as a volunteer |
| Team Lead | Everything a volunteer does, plus creating volunteers on their team and seeing team KPIs |
| Volunteer | Register, print prescription (queues the patient), mark seen, live queue |
| Patient | No app login; self-registration by Aadhaar card scan; staff-scan QR; passwordless status at `/s/<token>` |

## Privacy

Never store full Aadhaar. Only `aadhaar_last4`.

### Aadhaar card scan

The QR printed on the card is decoded **offline** in the browser — no provider, no API
call, no per-scan cost. It fills name, gender, date of birth (as age), address and
Aadhaar last-4; the card carries **no phone number**, so that is always typed. Only the
last four digits are stored.

The scan is not cryptographically verified, so the data carries the same assurance as
typing (ADR 0004). Set `AADHAAR_HASH_PEPPER` so scanned registrations can compute the
Person duplicate key.

### Registration SMS via MSG91 (optional)

Transactional Hinglish SMS for **desk registrations only**, when the patient has a
phone. Two messages: one at registration, one the day before the camp. **No SMS for
self-registrants** — a database trigger enforces this, because the registration SMS
embeds a live status link. **No SMS for camp-day walk-ins.** SMS never blocks
registration.

Set:

```
MSG91_AUTH_KEY=…
MSG91_SENDER_ID=SNPCP             # DLT-registered sender / header
MSG91_DLT_TE_ID_REGISTRATION=…    # (or MSG91_TEMPLATE_REGISTRATION) Flow / template id for registration
MSG91_DLT_TE_ID_REMINDER=…        # (or MSG91_TEMPLATE_REMINDER) separate Flow / template id for the reminder
AADHAAR_HASH_PEPPER=…             # Required Person HMAC secret (do not rotate during active camp)
CRON_SECRET=…                     # Bearer secret for Vercel Cron (/api/cron/reminder-sms)
```

**Registration DLT template** (Roman script only — exact text, four `{#var#}` slots in
order: **reg**, **date**, **venue**, **link**):

```
SNP Camp: Reg #{#var#}. {#var#} pe aana, {#var#}. Parchi rakhein. {#var#}
```

Example filled at maximum tested length (**158** GSM-7 characters, must stay ≤160):

```
SNP Camp: Reg #999999. 30 Sep 2026 pe aana, AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA. Parchi rakhein. https://snp-camps.vercel.app/s/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

In the MSG91 flow, name the variables `reg`, `date`, `venue`, `link` (same order).
Date values are compact (`30 Sep 2026`). Venue is truncated to 35 characters. Status
link is `NEXT_PUBLIC_SITE_URL` + `/s/<status_token>`.

**Day-before reminder DLT template** (separate template ID; three slots: **reg**,
**date**, **venue** — no link):

```
SNP Camp: Kal aana. Reg #{#var#}. {#var#} pe aana, {#var#}. Parchi rakhein.
```

A Vercel Cron job (`vercel.json`, `30 2 * * *` UTC ≈ **08:00 Asia/Kolkata**) calls
`GET /api/cron/reminder-sms` with `Authorization: Bearer $CRON_SECRET`. It texts
patients who are still `registered`, have a phone, and whose camp day is **tomorrow**
(Asia/Kolkata). Each patient is marked `reminder_sms_sent_at` so a double run cannot
charge twice. Provider failures are logged (`[sms-failure]` / `[reminder-sms]`) and
never affect desk flows.

**`CRON_SECRET` must be set in production.** The job is scheduled nightly and rejects
itself without it, which looks like silence rather than an error.
