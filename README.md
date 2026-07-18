# SNP Camps

Simple medical camp desk for **Sikar Nagarik Parishad (Kolkata)**.

## Camp flow (v3)

1. **Self-register** with **Aadhaar only** → provider verification → account created → **auto sign-in**
2. Patient sees **reg number + password** (also **SMS/WhatsApp** when configured)
3. On **logout**, reg number + new password are shown again (and re-sent via SMS/WhatsApp stubs)
4. **Desk print** (optional) → joins FCFS **queue** (`waiting`)
5. **Doctor scan** → **seen** (once only) — **no print required**
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

In Supabase Dashboard → SQL Editor, run:

`supabase/schema.sql`

For the current production lineage, apply these SQL files in order. The other SQL files in this directory are historical or superseded; do not apply them to a current database.

1. `supabase/fix-print-queue-doctor.sql`
2. `supabase/fix-camp-days.sql`
3. `supabase/fix-change-day-queue-lock.sql`
4. `supabase/fix-ambiguous-and-delete-camp.sql`
5. `supabase/fix-doctor-scan-no-print.sql`
6. `supabase/fix-security-and-account-claims.sql`
7. `supabase/production-readiness.sql`
8. `supabase/security-followup.sql`
9. `supabase/verified-registration-cutover.sql` (safe pre-deploy setup)
10. `supabase/advisor-cleanup.sql`
11. `supabase/dashboard-stats.sql`
12. `supabase/release-hardening.sql` (safe pre-deploy authorization/index/cleanup)
13. `supabase/lean-perf.sql` (partial indexes, desk KPI RPCs, no realtime on hot tables)
14. `supabase/fix-qr-staff-scan.sql` (lookup + assign RPCs for volunteer QR scan)

Queue and seat boards use **manual Refresh** or a **fixed 2-minute** poll — no live websockets.

The security/account migration must precede the app because patient-account and
OTP flows use its columns/RPCs. The final
`supabase/verified-registration-revoke-anon.sql` is a deployment cutover:

1. Deploy the frontend containing `/api/patient-register`.
2. Smoke-test a verified self-registration.
3. Apply the revoke file immediately.

Do not apply that final revoke before the matching frontend is live; the old
browser flow calls `register_patient` directly.

`GET /api/health` is a cheap liveness probe. `GET /api/health?ready=1` also
checks the required database shape, verified-registration RPC, service-role
configuration, and `AADHAAR_VERIFY_URL`; it returns 503 until all are ready.

### 2. Auth settings

- **Email**: enable Email provider (staff: admin, volunteer, doctor). Prefer **disable email confirm** for camp day.  
- Patient accounts use synthetic emails (`reg{N}@patients.snp.local`) + password.

### 3. Env

Copy `.env.example` → `.env.local`.

```
ADMIN_INVITE_CODE=...
VOLUNTEER_INVITE_CODE=...
SUPABASE_SERVICE_ROLE_KEY=...   # create volunteers/doctors, patient accounts
```

Optional later:

```
# Aadhaar eKYC / OTP provider (required for self-registration)
# AADHAAR_VERIFY_URL=
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

1. Open `/staff/register` with **admin** invite code  
2. Create a camp → set active  
3. Admin → add **doctors** and volunteers  
4. Patients self-register with Aadhaar → doctor **scan** (print optional at desk)

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
| Patient | Aadhaar self-reg → auto login; reg+password on register & logout |

## Privacy

Never store full Aadhaar. Only `aadhaar_last4`.

### Aadhaar verify / auto-fill (optional)

1. **Verify**: `AADHAAR_VERIFY_URL` — POST `{ "aadhaar": "12digits", "action": "verify" }`. Self-registration is disabled until a provider is configured; a checksum alone is never treated as identity verification.
2. **Lookup / auto-fill**: set `NEXT_PUBLIC_AADHAAR_LOOKUP_ENABLED=true` and `AADHAAR_LOOKUP_URL`.  
3. Optional `AADHAAR_LOOKUP_SECRET` / `AADHAAR_VERIFY_SECRET` as Bearer token.

Provider lookup should return JSON: `full_name`, `gender`, `age` or `dob`, `address`, `phone`, `email`.

### SMS / WhatsApp (optional)

Set `SMS_WEBHOOK_URL` and/or `WHATSAPP_WEBHOOK_URL`. App POSTs JSON:

```json
{ "phone": "+91…", "message": "…", "template": "registration|credentials", "channel": "sms|whatsapp" }
```

Until configured, registration and logout still show credentials on screen; notify status reports “not configured yet”.
