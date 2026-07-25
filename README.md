# SNP Camps

Simple medical camp desk for **Sikar Nagarik Parishad (Kolkata)**.

## Camp flow (v4)

Two registration paths, then one shared queue:

1. **Desk registration (Staff):** Staff registers the patient at the Volunteer Desk → a **Passcode** is shown once and stored for the Desk Slip → **print** joins the **FCFS Queue** (`waiting`) and prints the Desk Slip (reg number + Passcode + Patient QR).
2. **Self-register (phone OTP):** When SMS is configured, the patient verifies phone OTP → details → account linked → **auto sign-in**. A Desk Slip can still be printed later by Staff if the reg-number login path is needed.
3. **Patient login:** registration number + **Passcode** from the Desk Slip (phone OTP remains an alternative when configured). Logout ends the session without changing credentials.
4. **Lost slip is expected:** Staff **reissue** a new Passcode (the old one stops working) and reprint the Desk Slip. The Desk Slip is **required** for the reg-number login path because it carries the Passcode.
5. **Doctor scan** → review patient → confirm → **Seen** (once only) — print is not required for the doctor path.
6. Re-scan of a Seen patient is **blocked** (“Already seen by Dr X”).

- Patient QR is for **camp-crew scan only** (payload `/p/{uuid}` — no phone QR login)
- One active camp, single FCFS Queue; doctor recorded when Seen
- Aadhaar: full number used only for verify/lookup in memory; **last 4 digits only** stored

## Auth model

Patients prove identity with **registration number + Passcode** printed on the **Desk Slip**, or with phone OTP when SMS is configured. The Passcode is the Supabase Auth password for the synthetic account; plaintext is shown only once to Staff at issue/reissue and never returned to unauthenticated callers. The authority for this model is [`docs/adr/0001-passcode-on-desk-slip.md`](docs/adr/0001-passcode-on-desk-slip.md). Any future change to the auth model updates `README.md`, `CONTEXT.md`, and a new or amended ADR together — or none of them.

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
also checks the required database shape (via `app_database_contract` and table
probes), service-role configuration, and Supabase Phone Auth/SMS provider
settings; it returns 503 until all are ready. The readiness path is
per-IP rate-limited (12/min) so it cannot be used as an amplification vector.

### 2. Auth settings

- **Email**: enable Email provider (staff: admin, volunteer, doctor). Prefer **disable email confirm** for camp day.  
- **Phone**: enable Phone Auth and configure a supported SMS provider/sender.
  Confirm a real `+91` test number receives and verifies an OTP before launch.
  Review Supabase Auth OTP expiry and rate limits for expected camp traffic.
- Patient accounts use synthetic emails (`reg{N}@patients.snp.local`) + **Passcode** (Auth password issued at the desk and printed on the Desk Slip).

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
# SMS_WEBHOOK_URL=
# WHATSAPP_WEBHOOK_URL=
# NOTIFY_WEBHOOK_SECRET=
```

### 4. Local

```bash
npm install
npm run dev
```

1. Sign in at `/login` with the bootstrapped admin.
2. Create a camp and set it active.
3. Add doctors and volunteers from the admin desk.
4. Patients self-register with phone OTP; Aadhaar auto-fill is optional when a lookup provider is configured.

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
| Patient | Reg number + desk-slip passcode login (phone OTP alternative); registration profile, staff-scan QR, day and queue status |

## Privacy

Never store full Aadhaar. Only `aadhaar_last4`.

### Aadhaar auto-fill (optional)

Set `NEXT_PUBLIC_AADHAAR_LOOKUP_ENABLED=true` and `AADHAAR_LOOKUP_URL`.
`AADHAAR_LOOKUP_SECRET` is sent as a Bearer token. This is optional auto-fill;
phone OTP remains the registration identity check, and only Aadhaar last four
digits are stored.

Provider lookup should return JSON: `full_name`, `gender`, `age` or `dob`, `address`, `phone`, `email`.

### SMS / WhatsApp (optional)

Set `SMS_WEBHOOK_URL` and/or `WHATSAPP_WEBHOOK_URL`. App POSTs JSON:

```json
{ "phone": "+91…", "message": "…", "template": "registration", "channel": "sms|whatsapp" }
```

Until configured, notify status reports “not configured yet”; desk registration still issues a Passcode on the Desk Slip for the reg-number login path. Logout never rotates or reveals credentials.

These notification webhooks do not deliver Supabase Auth OTPs. Configure the
Phone Auth SMS provider separately under Auth settings and keep readiness at
503 until a real OTP smoke test succeeds.
