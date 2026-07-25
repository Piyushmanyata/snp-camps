# SNP Camps — Domain Context & Ubiquitous Language

## Ubiquitous Language

* **Camp**: A medical camp event organized by Sikar Nagarik Parishad. Only one camp can be active at a time.
* **Camp Day**: A specific calendar date on which a camp operates.
* **Patient**: An individual registering for medical examination. Assigned a sequential registration number. Patients do **not** sign into the app. Identity at camp is the registration number + physical desk slip; remote status is a passwordless **status link** (`/s/<token>`).
* **Staff**: An admin or volunteer. Runs the volunteer desk and patient management (register, print, change camp day). Does **not** include doctor. Predicates: TypeScript `isStaff`, SQL `is_staff()`.
  _Avoid_: Using “staff” for doctors or for “any signed-in camp role.”
* **Camp crew**: An admin, volunteer, or doctor — any non-patient operational role at a camp. Used for QR scan handoff and role-desk access that all three share. Predicates: TypeScript `isCampCrew`, SQL `is_camp_crew()`.
  _Avoid_: Calling this “staff” (that term excludes doctors).
* **Patient QR**: A unique patient identification QR code containing payload `/p/{uuid}` (or compact `snp:{uuid}`) for camp-crew scanning (not for login).
* **Status token / status link**: Un-guessable token on the patient row; open `/s/<token>` with no sign-in to see day, queue status, and position. Intended for SMS later. Not the staff-scan QR.
* **FCFS Queue**: First-Come, First-Served line of registered patients waiting for doctor examination (`waiting` status).
* **Volunteer Desk**: Station operated by staff (volunteers; admins may act as staff) for patient onboarding, Aadhaar auto-fill, desk slip printing, queue routing, and doctor assignment. **Only** place walk-ins are registered (no public self-registration).
* **Doctor Station**: View used by attending doctors to scan patient QR codes, review records, and mark patient as `seen`.
* **Desk Slip**: Physical registration token printed at the volunteer desk. Carries reg number and staff-scan QR for queue tracking. Print moves the patient into the FCFS queue. Losing the slip is normal — staff can reprint.
* **Seen**: Final state of patient consultation. Re-scanning a `seen` patient is permanently blocked.
* **Phone number → patient relationship**: A phone number identifies a *household*, not a Patient. A Patient is identified by registration number. Several family members may share one phone for contact/SMS; PHI is scoped to the registration and status token, never to “whoever has this phone.”
* **Print-then-queue ordering**: Printing a Desk Slip moves the Patient into the FCFS Queue *before* the print dialog opens, deliberately — the queue entry is the operationally meaningful act and the paper is a convenience. A cancelled print therefore leaves the Patient queued, which is correct because they are physically at the desk.
* **Volunteer / staff KPIs**: One function (`staff_person_kpis`) defines a volunteer’s numbers for both the volunteer desk and the admin staff panel. Counts are always scoped to an explicit active camp. **With no active camp, every metric is zero** — not an all-time career total, not null. The desk explains “No active camp” so zeros are not read as “you have done nothing.” Do not reintroduce all-time counting or a second KPI RPC.
* **Aadhaar last-4 + name uniqueness**: Within one Camp, the pair *(Aadhaar last 4 digits, normalised full name)* is unique for non-overridden registrations. Two different people can share a common name and the same last four digits; a hard block at the desk is unacceptable. On conflict the system names the **conflicting registration number**. **Staff** (admin or volunteer) may take an explicit, one-shot **override**; the new registration records who overrode and when. Override is never sticky, never automatic, never available outside desk registration.

## System-Wide Design & UX Goals

* **Scope**: Full End-to-End System Overhaul (Volunteer Desk, Doctor Station, Admin Dashboard; passwordless patient status page).
* **Theme & Palette**: Emerald & Slate Medical Tech Aesthetic (Primary Emerald `#059669` / `#047857`, Slate `#0f172a`, glassmorphic navigation, status badge glows).
* **Typography**: Plus Jakarta Sans (`next/font/google`) with tabular numeric alignment for registration numbers, queue counts, and timestamps.
* **Micro-Interactions**: Tactile press scaling (`scale(0.98)`), glassmorphic toast notifications, smooth focus rings (`ring-emerald-500/40`), glowing status badges, and `prefers-reduced-motion` compliance.
* **Design Philosophy**: High polish, high contrast for field visibility, responsive layout, minimal diffs (Ponytail), and zero unnecessary friction.
