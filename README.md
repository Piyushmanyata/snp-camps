# SNP Camps

Simple medical camp desk for **Sikar Nagarik Parishad (Kolkata)**.

- Patient registration → reg no + QR  
- One active camp, FCFS queue  
- Volunteer scan QR → print prescription form (marks **seen**)  
- Admin: camps, search, counts  
- Aadhaar: optional, **last 4 digits only**

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
| Patient | OTP login, own profile + QR |

## Privacy

Never store full Aadhaar. Only `aadhaar_last4`.
