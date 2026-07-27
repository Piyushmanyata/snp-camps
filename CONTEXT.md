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
* **Patient queue states** (strict order): **`registered` → `waiting` → `seen`**.
  * **`registered`**: Recorded with a registration number, **not physically present**, **not in the FCFS Queue**. Used for pre-registration on a future Camp Day.
  * **`waiting`**: Checked in on camp day; physically present; in the FCFS Queue ordered by **check-in time** (`queued_at`), not registration time.
  * **`seen`**: Doctor finished. Terminal. Re-scan is blocked (“Already seen by Dr X”).
* **FCFS Queue**: First-Come, First-Served line of patients who are **physically present and waiting** (`waiting` only). Seat-board counts and KPIs that count `waiting` automatically exclude pre-registered patients — do not paper over with filters; fix the state.
* **Check-in**: One staff action that moves `registered` → `waiting` through the single RPC `check_in_patient`. Routes: desk-slip QR scan, typing registration number, or name-search row tap. Idempotent if already `waiting` (no queue reorder). Blocked if `seen`.
* **Walk-in vs pre-reg**: Registering on an **active Camp Day (today, Asia/Kolkata)** registers **and** checks in in one step (`waiting`). Registering for a future day stays `registered`. **No desk mode toggle** — the system uses the camp day date.
* **Volunteer Desk**: Station operated by staff (volunteers; admins may act as staff) for patient onboarding, Aadhaar auto-fill, check-in, desk slip printing, queue routing, and doctor assignment. The **only** place walk-ins are registered and patients are checked in (online self-registration is available for pre-registration, but walk-in registration and physical check-in require the Volunteer Desk).
* **Self-registration**: Patient self-service registration online gated on Aadhaar eKYC OTP verification (`/self-register`). Patient queue status is **ALWAYS `registered`** (NEVER `waiting`), even if registering for today's camp day, preserving the invariant that `waiting` means physically present in the hall. Requires a configured eKYC provider (`AADHAAR_KYC_PROVIDER` and `AADHAAR_HASH_PEPPER` / `AADHAAR_KYC_PEPPER`); off with clear unavailable message when unconfigured.
* **Aadhaar verified**: Patient identity confirmed via Aadhaar eKYC OTP. Absence of Aadhaar verification is normal for walk-ins registered at the Volunteer Desk and indicates self-declared identity.
* **Contact phone rule (Self-registration)**: The phone number recorded during self-registration is strictly the OTP-delivered number from Aadhaar eKYC. It is uneditable by the patient to ensure SMS notifications reach a number the patient demonstrably controls. Patients with a stale phone number on Aadhaar will not receive SMS and must update their contact number at the Volunteer Desk (where staff can edit phone numbers).
* **One-per-Aadhaar-per-Camp**: Enforced uniqueness of 1 self-registration per patient per Camp, keyed on HMAC-SHA256 hash (`aadhaar_hash` using `AADHAAR_HASH_PEPPER` / `AADHAAR_KYC_PEPPER`), **NOT on phone number** (because family members in a household frequently share a single mobile number). Re-registering with the same Aadhaar in the same Camp returns the patient's existing registration number and status link without creating a duplicate row.
* **Doctor Station**: Doctor-only desk. Scan or type a registration number → patient details & prescription. Re-scanning a `seen` patient opens their existing prescription. If all treatment orders are pending (or 0 orders exist), doctors/admins can perform unlocked edits on diagnosis, examination, medicines, advice, spectacles type, and destinations. Once any treatment order has been acted upon (fulfilled, deferred, or cancelled), the prescription is locked against direct edits, and doctors/admins append chronological amendments via `add_prescription_amendment`. Volunteers are refused edit/amendment actions.
* **Desk Slip**: Physical registration token printed at the volunteer desk. Carries large reg number, name, camp day, venue, and staff-scan Patient QR (no passcode). Format is a station setting: **A4 multi-up** (2×2 with cut lines) or **58mm thermal**. Printing a still-`registered` patient also checks them in (same state as dedicated check-in). Losing the slip is normal — staff check in by name or reg number.
* **Seen**: Final state of patient consultation. Re-scanning a `seen` patient opens their prescription record (unlocked for direct edit if all treatment orders remain pending; locked with append-only amendments once any treatment order is acted upon).
* **Phone number → patient relationship**: A phone number identifies a *household*, not a Patient. A Patient is identified by registration number. Several family members may share one phone for contact/SMS; PHI is scoped to the registration and status token, never to “whoever has this phone.”
* **Name-search check-in**: For patients who pre-registered, lost the slip, forget the number, and gave no phone. Prefix match on normalised name (case-folded, whitespace-collapsed), active camp, **`registered` only**; rows show name, age, and address (locality).
* **Volunteer / staff KPIs**: One function (`staff_person_kpis`) defines a volunteer’s numbers for both the volunteer desk and the admin staff panel. Counts are always scoped to an explicit active camp. **With no active camp, every metric is zero** — not an all-time career total, not null. The desk explains “No active camp” so zeros are not read as “you have done nothing.” Do not reintroduce all-time counting or a second KPI RPC.
* **Aadhaar last-4 + name uniqueness**: Within one Camp, the pair *(Aadhaar last 4 digits, normalised full name)* is unique for non-overridden registrations. Two different people can share a common name and the same last four digits; a hard block at the desk is unacceptable. On conflict the system names the **conflicting registration number**. **Staff** (admin or volunteer) may take an explicit, one-shot **override**; the new registration records who overrode and when. Override is never sticky, never automatic, never available outside desk registration.
* **Likely-duplicate soft warn** (not a hard unique): At desk submit, within the **active Camp only**, if another patient matches **normalised name + age** or the same **phone** (when both have one), the RPC raises `LIKELY_DUPLICATE:reg=N`. The form shows one Hinglish sentence and two actions: **Check them in instead** (primary — abandons the new reg and calls `check_in_patient`) or **Register anyway** (one-shot override with audit columns). Never blocks; never as-you-type. Aadhaar uniqueness is separate and still hard.

## System-Wide Design & UX Goals

* **Scope**: Full End-to-End System Overhaul (Volunteer Desk, Doctor Station, Admin Dashboard; passwordless patient status page).
* **Theme & Palette**: Emerald & Slate Medical Tech Aesthetic (Primary Emerald `#059669` / `#047857`, Slate `#0f172a`, high-contrast field cards, clean solid status badges). Retired visual guidance (glow effects, glassmorphic navigation, status badge glows) is removed and superseded by high-contrast WCAG 2.2 AA compliant field elements (#69, #73).
* **Typography**: Plus Jakarta Sans (`next/font/google`) with tabular numeric alignment for registration numbers, queue counts, and timestamps.
* **Micro-Interactions**: Tactile press scaling (`scale(0.98)`), solid high-contrast toast notifications, smooth focus rings (`ring-emerald-500/40`), clean status badges, and `prefers-reduced-motion` compliance.
* **Design Philosophy**: High polish, high contrast for field visibility, responsive layout, minimal diffs (Ponytail), WCAG 2.2 AA accessibility, and zero unnecessary friction.

## Document Authority Precedence

When governing documentation or specifications conflict, instructions and requirements resolve according to the following strict hierarchy:

1. **Remediation & Specification Contracts**: Closed/accepted issue remediation specifications (#56 for auth/realtime/least-privilege boundaries, #68 for fail-closed readiness, #72 for test selection, #74 for evidence governance).
2. **`CONTEXT.md`**: Ubiquitous language, domain context, lifecycle invariants, role boundaries, and accepted design-system rules.
3. **`README.md`**: Operations, deployment setup, build/verify gates, auth model reference, and MSG91 configuration.
4. **ADRs (`docs/adr/`)**: Architectural decision records (e.g., `0001-passcode-on-desk-slip.md` is superseded by #41/#45 passwordless model).
5. **Historical Spec Files (`docs/UI_UX_OVERHAUL_SPEC.md`, etc.)**: Retained for historical context only. Where historical specs conflict with accepted remediation rules (#56, #69, #73), accepted remediation rules and `CONTEXT.md` explicitly supersede them.

## Production Safety & Realtime Boundaries (#56)

* **Production Data Safety**: Production contains live medical camp operational data. **Production is NEVER assumed to be empty.** Running `db reset` or re-applying baseline SQL against production is strictly prohibited. Schema changes must use append-only incremental migrations validated via clean replay on disposable databases (#68).
* **Realtime Boundary**: Public patient Realtime channels are retired (#56). The `patients` table is strictly absent from the `supabase_realtime` publication (`patients_realtime_absent` check).
* **Polling**: Queue, seat board, and desk updates use manual Refresh or fixed polling — zero public WebSocket channels on patient rows.
* **Least Privilege & Role Boundaries**: Desk operations operate under strict SQL role functions: `isStaff()` (admin, volunteer) for desk registration/management, `isCampCrew()` (admin, volunteer, doctor) for QR lookup and assignment. Patients do not sign in and hold no Supabase Auth sessions.
* **Status Token Boundary**: Passwordless `/s/<token>` provides public status tracking via the `patient_status_by_token` RPC, returning only non-sensitive queue metrics (sensitive patient PII, phone, address, and Aadhaar details are stripped).

## Testing & Evidence Governance (#72, #74)

* **Test Selection Contract (#72)**: Testing standards are strictly governed by issue **#72** as the sole test-level selection contract. Brittle source-text regex assertions are prohibited. Tests must assert on empirical runtime behavior across defined seams:
  1. `node:test` behavioral unit suite (`tests/*.test.mjs`, `tests/empirical-challenge*.test.mjs`).
  2. Database integration suite (`tests/*.db.test.mjs`).
  3. Playwright role e2e suite (`e2e/*.spec.ts`).
  4. Full gate (`npm run verify`).
  5. JS route budgets (`npm run check:js-budget`).
* **Closure Evidence Governance (#74)**: Every ticket closure must strictly adhere to the issue **#74** evidence contract, including literal `npm run verify` output, DB test skip count declarations, e2e summary, coverage delta statements, and empirical red/green proof for bug fixes.

