# SNP Camps

Simple medical camp desk for **Sikar Nagarik Parishad (Kolkata)**.

## Camp flow (v6 — two-round)

Desk-only registration, **pre-reg + check-in**, one shared queue, passwordless patient status:

1. **Desk registration (Staff):** One screen — **full name + age required**; phone, Aadhaar last-4, gender, address, email optional. One button registers and opens print.
   - **Camp day = today** → walk-in: lands in **`waiting`** (in line) in one step.
   - **Future camp day** → pre-reg: stays **`registered`** (not in the line).
2. **Check-in** (pre-reg only): QR scan, reg number, or name search → `registered` → **`waiting`**. Line order is by check-in time. Double check-in is a no-op.
3. **Print desk slip** (optional reprint): reg number + staff-scan **Patient QR**. Printing a still-`registered` patient also checks them in.
4. **Doctor Station** → scan or type reg number → read-only details → **Mark seen** (once only; returns immediately to the next patient).
5. Re-scan of a Seen patient is **blocked** (“Already seen by Dr X”).
6. **Patient status (passwordless):** `/s/<token>` with no sign-in. There is **no patient login** and **no public self-registration**.

- Patient QR is for **camp-crew scan only** (payload `/p/{uuid}` or `snp:{uuid}` — never a login)
- One active camp; FCFS Queue = **`waiting` only** (physically present)
- Aadhaar: full number used only for verify/lookup in memory; **last 4 digits only** stored

## Auth model

**Staff** (admin, volunteer, doctor) sign in with email + password at `/login`.

**Patients** do not authenticate in the app. Registration is desk-only. Status is passwordless via `/s/<token>`. The former desk-slip passcode + phone-OTP patient login model is **superseded** (see [`docs/adr/0001-passcode-on-desk-slip.md`](docs/adr/0001-passcode-on-desk-slip.md) and issues #41 / #45). Any future change to this model updates `README.md`, `CONTEXT.md`, and a new or amended ADR together — or none of them.

## Stack

Next.js · Supabase · Vercel · GitHub: [Piyushmanyata/snp-camps](https://github.com/Piyushmanyata/snp-camps)

## Setup

### 1. Database schema (Supabase CLI)

Schema lives only under `supabase/migrations/`. There is one **baseline**
migration that reproduces the full current schema on an empty database, plus
any later incremental files. The CLI keeps the migration ledger.

**Baseline is append-never.** Do not edit
`supabase/migrations/*_baseline_*.sql` after it is committed. Every schema
change is a new file from `npx supabase migration new <descriptive_name>`.
Hand-editing the baseline is how the ledger and production drift apart.

**Before any `db push`:** run `npx supabase migration list` against the linked
project and confirm every local file has a definite remote status
(applied or pending). If the remote column is empty for a file that already
exists in production (e.g. after a squash), repair the ledger with
`npx supabase migration repair --status applied <version>` — that writes a
history row only and **does not** execute SQL. Never treat an empty remote
column as “safe to push.”

**Empty project (local or new remote):**

```bash
npx supabase start          # local Docker stack (optional)
npx supabase db reset       # apply all local migrations on a clean DB
# or, linked remote empty project:
npx supabase link           # prompts for project ref; uses dashboard DB password
npx supabase migration list # confirm ledger before push
npx supabase db push        # applies pending migrations transactionally
```

Do **not** re-run the baseline against a database that already has this schema
(production already does). Do **not** run `db reset` against production.

**How to change the schema:**

1. `npx supabase migration new <descriptive_name>` — creates an empty SQL file
   under `supabase/migrations/` with a CLI timestamp.
2. Write the incremental SQL in that file (prefer reversible, small steps).
3. Apply and verify on a disposable DB first:
   - Local: `npx supabase db reset` (or `migration up`)
   - Linked remote (non-prod): `npx supabase db push`
4. Commit the migration file. Never hardcode a project ref or scrape passwords
   from `.env.local` in scripts — use `supabase link` / env vars the CLI
   documents, or the dashboard password prompt.

Queue and seat boards use **manual Refresh** or a **fixed 2-minute** poll — no live websockets.

`GET /api/health` is a cheap, open liveness probe. `GET /api/health?ready=1`
also checks service-role configuration, table-shape probes (`camps`,
`profiles`, `patients`), and Supabase Phone Auth/SMS provider settings; it
returns 503 until those pass. The JSON includes `migrationVersion` from the
migration ledger (`latest_applied_migration()`), not a hand-maintained contract
string. The readiness path is per-IP rate-limited (12/min) so it cannot be used
as an amplification vector.

### 2. Auth settings

- **Email**: enable Email provider (staff: admin, volunteer, doctor). Prefer **disable email confirm** for camp day.
- Patient app login and phone OTP self-registration are **not** used. Optional MSG91 registration SMS can send reg number + status link (not Supabase Auth OTPs).

### 3. Env

Copy `.env.example` → `.env.local`.

```
SUPABASE_SERVICE_ROLE_KEY=...   # server-only; never expose with NEXT_PUBLIC_
```

Bootstrap the first admin once. Set `SUPABASE_PROJECT_REF`,
`ADMIN_BOOTSTRAP_EMAIL`, and a unique `ADMIN_BOOTSTRAP_PASSWORD` of at least 14
characters, then run `npm run bootstrap:admin`. Remove those three bootstrap
values immediately after it succeeds. All later volunteers and doctors are
created by an active admin; there is no public staff self-registration route.

Optional later:

```
# Optional Aadhaar lookup provider
# AADHAAR_LOOKUP_URL=
# MSG91_AUTH_KEY=
# MSG91_SENDER_ID=
# MSG91_TEMPLATE_REGISTRATION=
```

### 4. Local

```bash
npm install
npm run dev
```

1. Sign in at `/login` with the bootstrapped admin.
2. Create a camp and set it active.
3. Add doctors and volunteers from the admin desk.
4. Register walk-ins from the volunteer/admin desk; Aadhaar auto-fill is optional when a lookup provider is configured.

### 5. Deploy Vercel

```bash
npx vercel
```

Add the same env vars in Vercel. Set `NEXT_PUBLIC_SITE_URL` to the production URL (for QR links).

## Verification and capacity testing

```bash
npm run verify
```

### Closing a ticket

A ticket is closed only when its closing comment contains:

1. The literal terminal output of `npm run verify` — lint, unit tests and production build, all three, from one run.
2. The literal terminal output of `npm run test:e2e`, or a named specific environment blocker (missing credential, no Docker daemon). "Not run this session" is not a blocker.
3. An explicit statement of what test coverage the change **removed**, or "no coverage removed".
4. For a bug fix: proof the new test can fail — remove the fix, record the red output, restore it, record the green output. Both go in the comment.

`npm test` alone and `npx tsc --noEmit` alone are diagnostics, not gates.

Run load tests only against a production-like staging deployment:

```bash
LOAD_BASE_URL=https://staging.example.com npm run load:smoke
```

The harness is read-only by default. More than 100 virtual users requires
`ALLOW_HIGH_LOAD=true`; coordinate a 5,000-VU test with Supabase/Vercel first.
Use realistic think time and seeded data, and require under 1% errors with p95
below 1.5 seconds before treating the result as a capacity signal.

## Roles

| Role | Access |
|------|--------|
| Admin | Camps, search, counts, create volunteers/doctors, desks, print |
| Volunteer | Register, print (queue), scan + pick doctor, live queue |
| Doctor | Login, stats, **scan only** (self-assign, no print required) |
| Patient | No app login; desk registration; staff-scan QR; passwordless status at `/s/<token>` |

## Privacy

Never store full Aadhaar. Only `aadhaar_last4`.

### Aadhaar auto-fill (optional)

Set `NEXT_PUBLIC_AADHAAR_LOOKUP_ENABLED=true` and `AADHAAR_LOOKUP_URL`.
`AADHAAR_LOOKUP_SECRET` is sent as a Bearer token. This is optional desk
auto-fill; only Aadhaar last four digits are stored.

Provider lookup should return JSON: `full_name`, `gender`, `age` or `dob`, `address`, `phone`, `email`.

### Registration SMS via MSG91 (optional)

Transactional Hinglish SMS on desk registration (when the patient has a phone).
**Not** Supabase Auth OTP. SMS never blocks registration.

Set all three:

```
MSG91_AUTH_KEY=…
MSG91_SENDER_ID=SNPCP          # DLT-registered sender / header
MSG91_TEMPLATE_REGISTRATION=…  # MSG91 Flow / template id for the body below
```

**DLT template to register** (Roman script only — exact text, four `{#var#}` slots
in order: **reg**, **date**, **venue**, **link**):

```
SNP Camp: Reg #{#var#}. {#var#} pe aana, {#var#}. Slip rakhein. {#var#}
```

Example filled at maximum tested length (**158** GSM-7 characters, must stay ≤160):

```
SNP Camp: Reg #999999. 30 Sep 2026 pe aana, AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA. Slip rakhein. https://snp-camps.vercel.app/s/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

In the MSG91 flow, name the variables `reg`, `date`, `venue`, `link` (same order).
Date values are compact (`30 Sep 2026`). Venue is truncated to 35 characters.
Status link is `NEXT_PUBLIC_SITE_URL` + `/s/<status_token>`.

The old generic `SMS_WEBHOOK_URL` path was **removed** — one SMS provider only
(`src/lib/msg91.ts`). Admin → **Registration SMS (MSG91)** can send a real test
message and shows recent send failures (also logged as `[sms-failure]`).

Day-before reminder SMS is a separate ticket (#52).
