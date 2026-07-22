# SNP Camps

Simple medical camp desk for **Sikar Nagarik Parishad (Kolkata)**.

## Camp flow (v3)

1. **Self-register** with **phone OTP** → details → account linked → **auto sign-in**
2. Patient sees **reg number + optional one-time backup password** (also **SMS/WhatsApp** when configured)
3. **Logout** ends the session without changing patient credentials; phone OTP remains available for recovery
4. Explicit **desk print** (optional) → joins FCFS **queue** (`waiting`)
5. **Doctor scan** → review patient → confirm → **seen** (once only) — **no print required**
6. Volunteer/admin can print for queue or assign a doctor on scan
7. Re-scan of a seen patient is **blocked** (“Already seen by Dr X”)

- Patient QR is for **volunteer/doctor scan only** (payload `/p/{uuid}` — no phone QR login)
- Print is optional desk convenience; doctors only need to scan
- One active camp, single FCFS queue; doctor recorded when seen
- Aadhaar: full number used only for verify/lookup in memory; **last 4 digits only** stored

## Stack

Next.js · Supabase · Vercel · GitHub: [Piyushmanyata/snp-camps](https://github.com/Piyushmanyata/snp-camps)

## Setup

### 1. Supabase SQL

For a new, empty Supabase project, run `supabase/schema.sql` once in the SQL
Editor. It is the canonical schema and already contains the complete reviewed
migration lineage. Do not run it on an existing database.

For an existing deployment, apply only unapplied files from
`supabase/migrations` in timestamp order. Rehearse every migration on a
production-shaped disposable database before applying it to production. The
current release is deliberately split so neither the old nor new app sees an
incompatible schema:

1. Apply `20260722000000_disabled_staff_expand.sql` (backward-compatible
   column, disabled-account guards, and profile immutability).
2. Deploy the matching application and pass `/api/health?ready=1`.
3. Apply `20260722010000_production_hardening.sql` to enforce the new RLS, ACL,
   attribution, and queue contracts.
4. Re-run readiness, role smoke tests, and database privilege postconditions.

Do not batch both migrations ahead of the application deployment. After the
enforcement step, recover with a forward-fix migration; do not restore claim
token grants or remove `disabled_at`.

Queue and seat boards use **manual Refresh** or a **fixed 2-minute** poll — no live websockets.

`GET /api/health` is a cheap liveness probe. `GET /api/health?ready=1` also
checks the required database shape, service-role configuration, and Supabase
Phone Auth/SMS provider settings; it returns 503 until all are ready.

### 2. Auth settings

- **Email**: enable Email provider (staff: admin, volunteer, doctor). Prefer **disable email confirm** for camp day.  
- **Phone**: enable Phone Auth and configure a supported SMS provider/sender.
  Confirm a real `+91` test number receives and verifies an OTP before launch.
  Review Supabase Auth OTP expiry and rate limits for expected camp traffic.
- Patient accounts use synthetic emails (`reg{N}@patients.snp.local`) + password.

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
| Patient | Phone OTP self-registration and login; registration profile, QR, day and queue status |

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

Until configured, registration may show the one-time backup password on screen; notify status reports “not configured yet”. Logout never rotates or reveals credentials.

These notification webhooks do not deliver Supabase Auth OTPs. Configure the
Phone Auth SMS provider separately under Auth settings and keep readiness at
503 until a real OTP smoke test succeeds.
