# SNP Camps — Domain Context & Ubiquitous Language

## Ubiquitous Language

* **Camp**: A medical camp event organized by Sikar Nagarik Parishad. Only one camp can be active at a time.
* **Camp Day**: A specific calendar date on which a camp operates.
* **Patient**: An individual registering for medical examination. Assigned a sequential registration number. Auth identity for desk-issued logins is `reg{N}@patients.snp.local` plus a desk-slip **passcode** (Auth password, stored hashed by Supabase Auth). Phone OTP remains an alternative path when SMS is configured.
* **Staff**: An admin or volunteer. Runs the volunteer desk and patient management (register, print, issue/reissue passcodes, change camp day). Does **not** include doctor. Predicates: TypeScript `isStaff`, SQL `is_staff()`.
  _Avoid_: Using “staff” for doctors or for “any signed-in camp role.”
* **Camp crew**: An admin, volunteer, or doctor — any non-patient operational role at a camp. Used for QR scan handoff and role-desk access that all three share. Predicates: TypeScript `isCampCrew`, SQL `is_camp_crew()`.
  _Avoid_: Calling this “staff” (that term excludes doctors).
* **Patient QR**: A unique patient identification QR code containing payload `/p/{uuid}` for camp-crew scanning (not for login).
* **FCFS Queue**: First-Come, First-Served line of registered patients waiting for doctor examination (`waiting` status).
* **Volunteer Desk**: Station operated by staff (volunteers; admins may act as staff) for patient onboarding, Aadhaar auto-fill, desk slip printing, queue routing, and doctor assignment.
* **Doctor Station**: View used by attending doctors to scan patient QR codes, review records, and mark patient as `seen`.
* **Desk Slip**: Physical registration token printed at the volunteer desk. **Required** for the reg-number login path because it carries the one-time-shown **login passcode**. Also used for queue tracking and staff-scan QR. Losing the slip is normal — staff reissue a new passcode (old one stops working) and reprint.
* **Passcode**: Short random secret issued at desk registration (or on reissue), printed on the desk slip, used with the registration number for patient login. Stored only as a Supabase Auth password hash; plaintext returned only once to authenticated staff after issue/reissue.
* **Seen**: Final state of patient consultation. Re-scanning a `seen` patient is permanently blocked.
* **Phone number → patient relationship**: A phone number identifies a *household*, not a Patient. A Patient is identified by registration number. Several family members may share one phone for OTP or contact; login and PHI are always scoped to the registration number (and Passcode / session), never to “whoever has this phone.”
* **Print-then-queue ordering**: Printing a Desk Slip moves the Patient into the FCFS Queue *before* the print dialog opens, deliberately — the queue entry is the operationally meaningful act and the paper is a convenience. A cancelled print therefore leaves the Patient queued, which is correct because they are physically at the desk.
* **Volunteer / staff KPIs**: One function (`staff_person_kpis`) defines a volunteer’s numbers for both the volunteer desk and the admin staff panel. Counts are always scoped to an explicit active camp. **With no active camp, every metric is zero** — not an all-time career total, not null. The desk explains “No active camp” so zeros are not read as “you have done nothing.” Do not reintroduce all-time counting or a second KPI RPC.

## System-Wide Design & UX Goals

* **Scope**: Full End-to-End System Overhaul (Patient Portal, Volunteer Desk, Doctor Station, Admin Dashboard).
* **Theme & Palette**: Emerald & Slate Medical Tech Aesthetic (Primary Emerald `#059669` / `#047857`, Slate `#0f172a`, glassmorphic navigation, status badge glows).
* **Typography**: Plus Jakarta Sans (`next/font/google`) with tabular numeric alignment for registration numbers, queue counts, and timestamps.
* **Micro-Interactions**: Tactile press scaling (`scale(0.98)`), glassmorphic toast notifications, smooth focus rings (`ring-emerald-500/40`), glowing status badges, and `prefers-reduced-motion` compliance.
* **Design Philosophy**: High polish, high contrast for field visibility, responsive layout, minimal diffs (Ponytail), and zero unnecessary friction.
