# SNP Camps

Simple medical camp desk for **Sikar Nagarik Parishad (Kolkata)**.

## Camp flow (v2)

1. **Register** (self or desk) → status `registered`
2. **Print** prescription at desk (scan QR or search reg) → joins FCFS **queue** (`waiting`)
3. **Scan** by volunteer (pick any doctor) or doctor (self-assign) → **seen** (once only)
4. Re-scan of a seen patient is **blocked** (“Already seen by Dr X”)
5. Must print before seen — unprinted scan opens print, not assign

- Patient QR is for **staff scan only** (no phone QR login)
- Everyone needs a paper prescription (no paperless path)
- One active camp, single FCFS queue; doctor recorded when seen
- Aadhaar: optional, **last 4 digits only** stored

## Stack

Next.js · Supabase · Vercel · GitHub: [Piyushmanyata/snp-camps](https://github.com/Piyushmanyata/snp-camps)

## Setup

### 1. Supabase SQL

In Supabase Dashboard → SQL Editor, run:

`supabase/schema.sql`

Then apply queue/doctor migration (or use script):

`supabase/fix-print-queue-doctor.sql`  
`node scripts/apply-print-queue-doctor.mjs` (needs `SUPABASE_DB_PASSWORD`)

### 2. Auth settings

- **Email**: enable Email provider (staff: admin, volunteer, doctor). Prefer **disable email confirm** for camp day.  
- **Phone**: optional for patient OTP login (status view only). Desk registration works without it.

### 3. Env

Copy `.env.example` → `.env.local`.

```
ADMIN_INVITE_CODE=...
VOLUNTEER_INVITE_CODE=...
SUPABASE_SERVICE_ROLE_KEY=...   # create volunteers/doctors, patient accounts
```

### 4. Local

```bash
npm install
npm run dev
```

1. Open `/staff/register` with **admin** invite code  
2. Create a camp → set active  
3. Admin → add **doctors** and volunteers  
4. Register patients → **print** at desk → **scan** on volunteer/doctor desk

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
| Doctor | Login, stats (patients they saw), scan (self-assign), print |
| Patient | Optional login for reg/status; desk prints paper QR for staff scan |

## Privacy

Never store full Aadhaar. Only `aadhaar_last4`.

### Aadhaar auto-fill (optional)

1. Set `NEXT_PUBLIC_AADHAAR_LOOKUP_ENABLED=true` so the form attempts fetch after 12 digits.  
2. Set `AADHAAR_LOOKUP_URL` to your DigiLocker/KYC provider (POST `{ "aadhaar": "12digits" }`).  
3. Optional `AADHAAR_LOOKUP_SECRET` as Bearer token.  

Provider should return JSON: `full_name`, `gender`, `age` or `dob`, `address`, `phone`, `email`.  
If lookup is off or fails, the same manual form fields remain available.
