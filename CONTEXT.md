# SNP Camps — Domain Context & Ubiquitous Language

## Ubiquitous Language

* **Camp**: A medical camp event organized by Sikar Nagarik Parishad. Only one camp can be active at a time.
* **Camp Day**: A specific calendar date on which a camp operates.
* **Person**: The permanent, globally unique human, keyed on the Aadhaar HMAC and owning the permanent registration number and date of birth. Survives across every Camp.
  _Avoid_: Calling this a “patient record” — that conflates it with one camp visit.
* **Registration**: One Person's participation in one Camp. Owns queue state, camp day, prescription, and treatment orders. A returning Person keeps their registration number and gains a new Registration.
  _Avoid_: “Visit”, “enrolment”.
* **Patient**: A Person seen through the lens of one Registration — the individual attending a camp for medical examination. Patients do **not** sign into the app and hold no Supabase Auth session. Identity at camp is the registration number + physical desk slip; remote status is the passwordless **status link** (`/s/<token>`).
* **Patient lookup**: A public form accepting registration number + date of birth that *resolves to* a Person's existing status link. It is token resolution, not authentication — no session is created. Rate-limited, because registration numbers are enumerable. Patients registered manually at the desk have no date of birth and reach status via the patient QR on their slip instead.
  _Avoid_: “Patient login”, “patient account”, “patient sign-in” — all imply a session that does not exist.
* **Staff**: An admin, team lead, or volunteer. Runs the volunteer desk and patient management (register, print, change camp day). Does **not** include doctor. Predicates: TypeScript `isStaff`, SQL `is_staff()`.
  _Avoid_: Using “staff” for doctors or for “any signed-in camp role.”
* **Camp crew**: An admin, team lead, volunteer, or doctor — any non-patient operational role at a camp. Used for QR scan handoff and role-desk access that all four share. Predicates: TypeScript `isCampCrew`, SQL `is_camp_crew()`.
  _Avoid_: Calling this “staff” (that term excludes doctors).
* **Team Lead**: A login role with every volunteer power, plus the ability to create volunteers onto their own team and to see their team's rolled-up numbers. Created **only** by an admin; a Team Lead may never mint any role other than `volunteer`.
  _Avoid_: “Team member” — every role is a member of the team; this term names the supervisory relationship.
* **Team**: A Team Lead plus the volunteers linked to them. Implicit — there is no team entity, only a lead reference on a volunteer. Team membership is optional; a volunteer with no lead is **Unassigned** and still counts in camp totals and on the volunteer leaderboard.
* **Patient QR**: A unique patient identification QR code containing payload `/p/{uuid}` (or compact `snp:{uuid}`) for camp-crew scanning (not for login).
* **Status token / status link**: Un-guessable token on the patient row; open `/s/<token>` with no sign-in to see day, queue status, and position. Intended for SMS later. Not the staff-scan QR.
* **Patient queue states** (strict order): **`registered` → `waiting` → `seen`**.
  * **`registered`**: Recorded with a registration number, **not physically present**, **not in the FCFS Queue**. Used for pre-registration on a future Camp Day.
  * **`waiting`**: Checked in on camp day; physically present; in the FCFS Queue ordered by **check-in time** (`queued_at`), not registration time.
  * **`seen`**: Doctor finished. Terminal. Re-scan is blocked (“Already seen by Dr X”).
* **FCFS Queue**: First-Come, First-Served line of patients who are **physically present and waiting** (`waiting` only). Seat-board counts and KPIs that count `waiting` automatically exclude pre-registered patients — do not paper over with filters; fix the state.
* **Check-in**: One staff action that moves `registered` → `waiting` through the single RPC `check_in_patient`. Routes: desk-slip QR scan, typing registration number, or name-search row tap. Idempotent if already `waiting` (no queue reorder). Blocked if `seen`.
* **Walk-in vs pre-reg**: Registering on an **active Camp Day (today, Asia/Kolkata)** registers **and** checks in in one step (`waiting`). Registering for a future day stays `registered`. **No desk mode toggle** — the system uses the camp day date.
* **Register vs Register & print**: Two desk actions, both always available on every day. **Register** saves the patient and stops; **Register & print** saves and prints. Printing is never required to register. Check-in remains purely date-driven — neither button changes who becomes `waiting`; the camp day does. Printing a slip later, from the patient list, is always possible without re-registering.
  _Avoid_: Treating these as a “mode” — the buttons do not change desk behaviour, only whether paper comes out.
* **Volunteer Desk**: Station operated by staff (volunteers and team leads; admins may act as staff) for patient onboarding, Aadhaar auto-fill, check-in, desk slip printing, queue routing, and doctor assignment. The **only** place walk-ins are registered and patients are checked in (online self-registration is available for pre-registration, but walk-in registration and physical check-in require the Volunteer Desk).
* **Self-registration**: Patient self-service registration online by scanning the QR on their Aadhaar card (`/self-register`). Queue status is **ALWAYS `registered`** (NEVER `waiting`), even when registering for today's camp day, preserving the invariant that `waiting` means physically present in the hall. Requires no SMS, no OTP, and no eKYC provider configuration.
* **Aadhaar scanned**: Details were read from the QR on a physical Aadhaar card and are assumed authentic — **no** signature check and **no** OTP is performed, so this asserts provenance of the *data*, not confirmation of *identity*. Absence of a scan is normal for walk-ins typed in at the Volunteer Desk and indicates self-declared details.
  _Avoid_: “Aadhaar verified”, “eKYC verified” — the system verifies nothing.
* **Contact phone rule (Self-registration)**: The Aadhaar QR carries no phone number, so a self-registering patient types one and it is **self-declared and unverified**. Because the registration SMS embeds a live status link, **self-registration sends no registration SMS** — the confirmation screen showing registration number, patient QR, camp day, venue and status link is the receipt. The typed number is used only for reminder SMS, which carries no link by design.
* **One-Person-per-Aadhaar**: Globally enforced uniqueness of one Person per Aadhaar card, keyed on `HMAC-SHA256(last4 + normalised name + DOB + gender)` — **not** on phone number (family members in a household frequently share one mobile) and **not** on the full 12-digit number (the card QR yields only last-4). Applies to every scanned path, self-service and Volunteer Desk alike, with no override. Scanning the same card again returns the existing Person's registration number and status link rather than creating a duplicate; within an active Camp it also returns their existing Registration.
  _Avoid_: “One-per-Aadhaar-per-Camp” — uniqueness is global, not per Camp.
* **Doctor Station**: Doctor-only desk. Scan or type a registration number → patient details & prescription. Re-scanning a `seen` patient opens their existing prescription. If all treatment orders are pending (or 0 orders exist), doctors/admins can perform unlocked edits on diagnosis, examination, medicines, advice, spectacles type, and destinations. Once any treatment order has been acted upon (fulfilled, deferred, or cancelled), the prescription is locked against direct edits, and doctors/admins append chronological amendments via `add_prescription_amendment`. Volunteers and team leads are refused edit/amendment actions, but may **print** a prescription.
* **Desk Slip**: Physical registration token printed at the volunteer desk. Carries large reg number, name, camp day, venue, and staff-scan Patient QR (no passcode). Format is a station setting: **A4 multi-up** (2×2 with cut lines) or **58mm thermal**. Printing a still-`registered` patient also checks them in (same state as dedicated check-in). Losing the slip is normal — staff check in by name or reg number.
* **Registration print mode**: A per-Camp admin setting choosing what the desk prints — **Desk Slip** (default) or **Prescription Sheet**. Not a per-registration choice and not a volunteer setting.
* **Prescription Sheet**: A printed form pre-filled with reg number, name, age, gender, camp day, venue and the Patient QR, leaving ruled space for a doctor to write diagnosis, medicines and advice **by hand**. Used by camps whose doctor does not work in the app. It carries the Patient QR, so scan-based check-in and counter lookup still work.
  _Avoid_: Confusing it with the printed **Prescription** — that is a doctor's completed record, printed after the fact.
* **Awaiting treatment**: A patient who is `seen` and still has at least one `pending` treatment order. **Derived, not a queue state** — `queue_status` remains `registered → waiting → seen` and gains no fourth value. Splits into three station queues by order kind: **OT**, **Medicines** (`pharmacy`), and **Spectacles**. Visible to all camp crew.
  _Avoid_: Adding an `awaiting_treatment` queue status — completion is derived from the orders.
* **Counter**: A station that fulfils, defers or cancels treatment orders of one kind. In **Prescription Sheet** camps the counter is also where treatment orders are *created*, read off the patient's handwritten sheet at the moment they arrive.
* **Aadhaar lock**: On a successful Aadhaar scan the identity fields — legal name, DOB, gender, last-4 — become read-only and cannot be edited by any role, because they compute the duplicate key. Phone, address, email and camp day stay editable. When the scanned name is non-Latin the volunteer must supply a separate Latin **display name** for the slip and for name-search; the duplicate key always uses the verbatim scanned name, so a transliteration typo cannot create a second Person.
* **Seen**: Final state of patient consultation. Re-scanning a `seen` patient opens their prescription record (unlocked for direct edit if all treatment orders remain pending; locked with append-only amendments once any treatment order is acted upon).
* **Phone number → patient relationship**: A phone number identifies a *household*, not a Patient. A Patient is identified by registration number. Several family members may share one phone for contact/SMS; PHI is scoped to the registration and status token, never to “whoever has this phone.”
* **Name-search check-in**: For patients who pre-registered, lost the slip, forget the number, and gave no phone. Prefix match on normalised name (case-folded, whitespace-collapsed), active camp, **`registered` only**; rows show name, age, and address (locality).
* **Patients handled**: The volunteer KPI. A count of **distinct** patients a person registered *or* checked in — not a count of actions. One patient both registered and checked in by the same volunteer counts once.
* **Volunteer / staff KPIs**: One function (`staff_person_kpis`) defines a volunteer’s numbers for both the volunteer desk and the admin staff panel. Counts are always scoped to an explicit active camp. **With no active camp, every metric is zero** — not an all-time career total, not null. The desk explains “No active camp” so zeros are not read as “you have done nothing.” Do not reintroduce all-time counting or a second KPI RPC.
* **Team KPI rollup**: A Team Lead's number is the **distinct** patients handled by the lead themselves or by any volunteer currently linked to them. Because it is distinct and not a sum, it is normally **smaller** than the individual cards beneath it add up to — a patient registered by one teammate and checked in by another counts once. Screens showing a rollup must say “distinct patients” so the shortfall reads as truth, not as shaved numbers. Attribution follows a volunteer's **current** team link, so moving a volunteer moves their whole camp history with them.
* **Leaderboard**: Two separate rankings, always scoped to the active camp — one of Team Leads, one of individual volunteers — both ranked on distinct patients handled, descending. The Team Lead board shows team headcount beside each row, because absolute throughput naturally favours larger teams. Visible in full to all camp crew; exposes aggregate counts only, never patient PII.
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

