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

- Patient QR is for **staff scan only** (no phone QR login)
- Print is optional desk convenience; doctors only need to scan
- One active camp, single FCFS queue; doctor recorded when seen
- Aadhaar: full number used only for verify/lookup in memory; **last 4 digits only** stored

## Stack

Next.js · Supabase · Vercel · GitHub: [Piyushmanyata/snp-camps](https://github.com/Piyushmanyata/snp-camps)

## Setup

### 1. Supabase SQL

In Supabase Dashboard → SQL Editor, run:

`supabase/schema.sql`

Then apply migrations (or use scripts):

`supabase/fix-print-queue-doctor.sql`  
`supabase/fix-doctor-scan-no-print.sql`  
`supabase/fix-security-and-account-claims.sql`
`node scripts/apply-print-queue-doctor.mjs`  
`node scripts/apply-doctor-scan-no-print.mjs` (needs `SUPABASE_DB_PASSWORD`)
`node scripts/apply-security-and-account-claims.mjs` (needs `SUPABASE_DB_PASSWORD`)

Apply the security/account-claims migration before deploying the current app code;
the patient-account and OTP flows depend on its columns and RPCs.

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
