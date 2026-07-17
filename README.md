# SNP Camps

Simple medical camp desk for **Sikar Nagarik Parishad (Kolkata)**.

- Patient registration → reg no + QR (no password)  
- Patient scans QR → instant login on their phone  
- No phone? Staff print prescription from registration screen  
- Desk **scan** → add to queue · **print** → mark seen  
- One active camp, FCFS queue  
- Admin: camps, search, counts  
- Aadhaar at top of registration; auto-fill when lookup is enabled  
- Aadhaar: optional, **last 4 digits only** stored

## Stack

Next.js · Supabase · Vercel · GitHub: [Piyushmanyata/snp-camps](https://github.com/Piyushmanyata/snp-camps)

## Setup

### 1. Supabase SQL

In Supabase Dashboard → SQL Editor, run:

`supabase/schema.sql`

### 2. Auth settings

- **Email**: enable Email provider (staff). Prefer **disable email confirm** for camp day.  
- **Phone**: enable Phone + SMS (Twilio/MessageBird) for patient OTP. Desk registration works without it.

### 3. Env

Copy `.env.example` → `.env.local` (already seeded for your project).

```
ADMIN_INVITE_CODE=...
VOLUNTEER_INVITE_CODE=...
```

Optional: `SUPABASE_SERVICE_ROLE_KEY` for stronger staff role assignment.

### 4. Local

```bash
npm install
npm run dev
```

1. Open `/staff/register` with **admin** invite code  
2. Create a camp → set active  
3. Register patients → scan/print from `/volunteer`

### 5. Deploy Vercel

```bash
npx vercel
```

Add the same env vars in Vercel project settings. Set `NEXT_PUBLIC_SITE_URL` to the production URL (for QR links).

## Roles

| Role | Access |
|------|--------|
| Admin | Camps, search, counts, volunteer desk, print |
| Volunteer | Register, queue, scan, print |
| Patient | Scan QR to login (or legacy reg+password / OTP), own profile + QR |

## Privacy

Never store full Aadhaar. Only `aadhaar_last4`.

### Aadhaar auto-fill (optional)

1. Set `NEXT_PUBLIC_AADHAAR_LOOKUP_ENABLED=true` so the form attempts fetch after 12 digits.  
2. Set `AADHAAR_LOOKUP_URL` to your DigiLocker/KYC provider (POST `{ "aadhaar": "12digits" }`).  
3. Optional `AADHAAR_LOOKUP_SECRET` as Bearer token.  

Provider should return JSON: `full_name`, `gender`, `age` or `dob`, `address`, `phone`, `email`.  
If lookup is off or fails, the same manual form fields remain available.
