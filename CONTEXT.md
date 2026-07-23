# SNP Camps — Domain Context & Ubiquitous Language

## Ubiquitous Language

* **Camp**: A medical camp event organized by Sikar Nagarik Parishad. Only one camp can be active at a time.
* **Camp Day**: A specific calendar date on which a camp operates.
* **Patient**: An individual registering for medical examination. Authenticated via phone OTP and assigned a sequential registration number (`reg{N}@patients.snp.local`).
* **Patient QR**: A unique patient identification QR code containing payload `/p/{uuid}` for staff scanning (not for login).
* **FCFS Queue**: First-Come, First-Served line of registered patients waiting for doctor examination (`waiting` status).
* **Volunteer Desk**: Station operated by volunteers for patient onboarding, Aadhaar auto-fill, desk slip printing, queue routing, and doctor assignment.
* **Doctor Station**: View used by attending doctors to scan patient QR codes, review records, and mark patient as `seen`.
* **Desk Print / Slip**: Optional physical registration token printed at the volunteer desk for queue tracking.
* **Seen**: Final state of patient consultation. Re-scanning a `seen` patient is permanently blocked.

## System-Wide Design & UX Goals

* **Scope**: Full End-to-End System Overhaul (Patient Portal, Volunteer Desk, Doctor Station, Admin Dashboard).
* **Theme & Palette**: Emerald & Slate Medical Tech Aesthetic (Primary Emerald `#059669` / `#047857`, Slate `#0f172a`, glassmorphic navigation, status badge glows).
* **Typography**: Plus Jakarta Sans (`next/font/google`) with tabular numeric alignment for registration numbers, queue counts, and timestamps.
* **Micro-Interactions**: Tactile press scaling (`scale(0.98)`), glassmorphic toast notifications, smooth focus rings (`ring-emerald-500/40`), glowing status badges, and `prefers-reduced-motion` compliance.
* **Design Philosophy**: High polish, high contrast for field visibility, responsive layout, minimal diffs (Ponytail), and zero unnecessary friction.
