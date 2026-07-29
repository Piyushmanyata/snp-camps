# SNP Camps — Domain Context & Ubiquitous Language

The app's entire job is to move a patient through a line: **registered → waiting →
seen**. The clinical record is the printed prescription the doctor writes on by hand;
the app never stores diagnoses, medicines or treatment. See
[ADR 0008](docs/adr/0008-printing-queues-the-patient.md).

## Ubiquitous Language

* **Camp**: A medical camp event organized by Sikar Nagarik Parishad. Only one camp can be active at a time.
* **Camp Day**: A specific calendar date on which a camp operates.
* **Person**: The permanent, globally unique human, keyed on the Aadhaar HMAC and owning the permanent registration number and date of birth. Survives across every Camp.
  _Avoid_: Calling this a "patient record" — that conflates it with one camp visit.
* **Registration**: One Person's participation in one Camp. Owns queue state and camp day. A returning Person keeps their registration number and gains a new Registration.
  _Avoid_: "Visit", "enrolment".
* **Patient**: A Person seen through the lens of one Registration — the individual attending a camp for medical examination. Patients do **not** sign into the app and hold no Supabase Auth session. Identity at camp is the registration number + the printed prescription; remote status is the passwordless **status link** (`/s/<token>`).
* **Patient lookup**: A public form accepting registration number + date of birth that *resolves to* a Person's existing status link. It is token resolution, not authentication — no session is created. Rate-limited, because registration numbers are enumerable. Built and working but **deliberately unlinked** from the UI: the recovery path staff actually use is re-scanning the patient's Aadhaar card, which returns the existing registration.
  _Avoid_: "Patient login", "patient account", "patient sign-in" — all imply a session that does not exist.
* **Staff**: An admin, team lead, or volunteer — every login role there is. Runs the desk: register, print, mark seen, change camp day. Predicates: TypeScript `isStaff`, SQL `is_staff()`.
* **Camp crew**: Identical to **Staff**. The doctor holds no login role (ADR 0008), so the two sets collapsed. `isCampCrew` / `is_camp_crew()` survive only as a name for "anyone who works a camp"; they are aliases, and no code should branch on the difference.
  _Avoid_: Reintroducing a distinction between staff and camp crew — there is none.
* **Team Lead**: A login role with every volunteer power, plus the ability to create volunteers onto their own team and to see their team's rolled-up numbers. Created **only** by an admin; a Team Lead may never mint any role other than `volunteer`. A Team Lead works the same desk as a volunteer — `/volunteer` is their home, with a team panel added on top.
  _Avoid_: "Team member" — every role is a member of the team; this term names the supervisory relationship.
* **Team**: A Team Lead plus the volunteers linked to them. Implicit — there is no team entity, only a lead reference on a volunteer. Team membership is optional; a volunteer with no lead is **Unassigned** and still counts in camp totals and on the volunteer leaderboard.
* **Patient QR**: A unique patient identification QR code containing payload `/p/{uuid}` (or compact `snp:{uuid}`) for staff scanning (not for login). Printed top-right on the prescription, beside the Reg. No. box.
* **Status token / status link**: Un-guessable token on the patient row; open `/s/<token>` with no sign-in to see day, queue status, and position. Used in registration SMS. Not the staff-scan QR.
* **Patient queue states** (strict order): **`registered` → `waiting` → `seen`**. There is no fourth state, and adding one is the wrong answer to any new requirement (ADR 0007).
  * **`registered`**: Recorded with a registration number, **not physically present**, **not in the FCFS Queue**. Used for pre-registration on a future Camp Day.
  * **`waiting`**: Their prescription has been printed on camp day; physically present; in the FCFS Queue ordered by **print time** (`queued_at`), not registration time.
  * **`seen`**: The doctor has finished with them and a volunteer scanned them out. Terminal, apart from a ten-minute undo window.
* **FCFS Queue**: First-Come, First-Served line of patients who are **physically present and waiting** (`waiting` only). Seat-board counts and KPIs that count `waiting` automatically exclude pre-registered patients — do not paper over with filters; fix the state.
* **Print prescription**: The first of the two desk actions, and the act that puts a patient in the queue (`registered` → `waiting`) through the RPC `check_in_patient`. Routes: scan the patient QR, type the registration number, or register a walk-in first. **Idempotent** — a reprint keeps the original `queued_at`, so it never reorders the line and never re-queues someone. Refused for a `seen` patient, who may still reprint their paper.
  _Avoid_: Calling this "check-in" in UI copy. There is no separate check-in step any more; printing *is* it.
* **Mark seen**: The second desk action, through the RPC `mark_seen`. Records `seen_at` and the **volunteer who scanned** in `seen_by` — not a doctor. Idempotent: a double scan returns the original timestamp and never re-stamps the row. Refused with `not_in_queue` for a patient who was never printed for, so a mis-scan names its reason instead of failing silently.
* **Undo mark seen**: `undo_mark_seen` reverses a mis-scan within **ten minutes**, restoring `waiting` on the patient's original `queued_at` so they do not go to the back of the line. Outside the window it refuses and tells the volunteer to ask an admin.
* **Walk-in vs pre-reg**: Registering on an **active Camp Day (today, Asia/Kolkata)** and printing puts the patient in line in one desk visit. Registering for a future day stays `registered` and prints nothing. **No desk mode toggle** — the system uses the camp day date.
* **Volunteer Desk**: The one station staff operate (`/volunteer`; admins get the same surface on `/admin`). Two big buttons — **Print prescription** and **Mark seen** — with the live queue below; each button opens scan-or-type. Mobile-first, because phones do the scanning and a laptop does the printing. The **only** place walk-ins are registered (online self-registration covers pre-registration only).
* **Self-registration**: Patient self-service registration online by scanning the QR on their Aadhaar card (`/self-register`). Queue status is **ALWAYS `registered`** (NEVER `waiting`), even when registering for today's camp day, preserving the invariant that `waiting` means physically present in the hall. Requires no SMS, no OTP, and no eKYC provider configuration.
* **Aadhaar scanned**: Details were read from the QR on a physical Aadhaar card and are assumed authentic — **no** signature check and **no** OTP is performed, so this asserts provenance of the *data*, not confirmation of *identity*. Absence of a scan is normal for walk-ins typed in at the desk and indicates self-declared details.
  _Avoid_: "Aadhaar verified", "eKYC verified" — the system verifies nothing.
* **Contact phone rule (Self-registration)**: The Aadhaar QR carries no phone number, so a self-registering patient types one and it is **self-declared and unverified**. Because the registration SMS embeds a live status link, **self-registration sends no registration SMS** — the confirmation screen showing registration number, patient QR, camp day, venue and status link is the receipt. A database trigger enforces this; it is not left to application code.
* **One-Person-per-Aadhaar**: Globally enforced uniqueness of one Person per Aadhaar card, keyed on `HMAC-SHA256(last4 + normalised name + DOB + gender)` — **not** on phone number (family members in a household frequently share one mobile) and **not** on the full 12-digit number (the card QR yields only last-4). Applies to every scanned path, self-service and desk alike, with no override. Scanning the same card again returns the existing Person's registration number and status link rather than creating a duplicate; within an active Camp it also returns their existing Registration.
  _Avoid_: "One-per-Aadhaar-per-Camp" — uniqueness is global, not per Camp.
* **Prescription Sheet**: The printed form, and the camp's clinical record. Pre-filled with **venue, name, address, registration number, date, age, M/F and contact number** — identity only. Every clinical field (diagnosis checkboxes, blood sugar, BP, remarks, medicines, the glasses-prescription table) is left blank for handwriting. Carries the Patient QR top-right beside the Reg. No. box. **No e-mail field.** The whole form prints on every sheet, on plain paper.
* **Prescription template**: Per-camp overrides in `camps.prescription_template` (jsonb) — header/clinic name, footer text, ruled-section labels, and an uploaded logo. Null means the built-in default. The patient identity block, registration number and QR are fixed and not editable.
* **Letterhead**: One committed **image**, not typeset text — the header carries Devanagari and Bengali script that would silently break on any printing machine lacking those fonts (ADR 0008).
* **Aadhaar lock**: On a successful Aadhaar scan the identity fields — legal name, DOB, gender, last-4 — become read-only and cannot be edited by any role, because they compute the duplicate key. Phone, address and camp day stay editable. When the scanned name is non-Latin the volunteer must supply a separate Latin **display name** for the printed form and for name-search; the duplicate key always uses the verbatim scanned name, so a transliteration typo cannot create a second Person.
* **Phone number → patient relationship**: A phone number identifies a *household*, not a Patient. A Patient is identified by registration number. Several family members may share one phone for contact/SMS; PHI is scoped to the registration and status token, never to "whoever has this phone."
* **Name-search**: For patients who pre-registered, lost their paper, forget the number, and gave no phone. Prefix match on normalised name (case-folded, whitespace-collapsed), active camp, **`registered` only**; rows show name, age, and address (locality).
* **Patients handled**: The volunteer KPI. A count of **distinct** patients a person registered *or* printed for — not a count of actions. One patient both registered and printed by the same volunteer counts once.
* **Volunteer / staff KPIs**: One function (`staff_person_kpis`) defines a volunteer's numbers for both the desk and the admin staff panel. Counts are always scoped to an explicit active camp. **With no active camp, every metric is zero** — not an all-time career total, not null. The desk explains "No active camp" so zeros are not read as "you have done nothing." Do not reintroduce all-time counting or a second KPI RPC.
* **Team KPI rollup**: A Team Lead's number is the **distinct** patients handled by the lead themselves or by any volunteer currently linked to them. Because it is distinct and not a sum, it is normally **smaller** than the individual cards beneath it add up to — a patient registered by one teammate and printed by another counts once. Screens showing a rollup must say "distinct patients" so the shortfall reads as truth, not as shaved numbers. Attribution follows a volunteer's **current** team link, so moving a volunteer moves their whole camp history with them.
* **Leaderboard**: Two separate rankings, always scoped to the active camp — one of Team Leads, one of individual volunteers — both ranked on distinct patients handled, descending. The Team Lead board shows team headcount beside each row, because absolute throughput naturally favours larger teams. Visible in full to all staff; exposes aggregate counts only, never patient PII.
* **Seat caps**: Enforced for **pre-registration only**. A walk-in physically standing at the desk is never turned away because a day is notionally full.
* **Aadhaar last-4 + name uniqueness**: Within one Camp, the pair *(Aadhaar last 4 digits, normalised full name)* is unique for non-overridden registrations. Two different people can share a common name and the same last four digits; a hard block at the desk is unacceptable. On conflict the system names the **conflicting registration number**. Staff may take an explicit, one-shot **override**; the new registration records who overrode and when. Override is never sticky, never automatic, never available outside desk registration.
* **Likely-duplicate soft warn** (not a hard unique): At desk submit, within the **active Camp only**, if another patient matches **normalised name + age** or the same **phone** (when both have one), the RPC raises `LIKELY_DUPLICATE:reg=N`. The form shows one Hinglish sentence and two actions: **Print for them instead** (primary — abandons the new registration and queues the existing one) or **Register anyway** (one-shot override with audit columns). Never blocks; never as-you-type. Aadhaar uniqueness is separate and still hard.

## Language

A deliberate split, and leaks in either direction are bugs:

* **Patients read Hinglish** — the self-registration flow, the status page, SMS.
* **Staff read English** — every desk, admin and error surface.

No i18n framework. There are exactly two audiences and they never share a screen.

## System-Wide Design & UX Goals

* **Scope**: Volunteer/admin desk, admin dashboard, patient self-service, passwordless status page.
* **Theme & Palette**: Emerald & Slate medical-tech aesthetic (Primary Emerald `#059669` / `#047857`, Slate `#0f172a`, high-contrast field cards, clean solid status badges).
* **Typography**: Plus Jakarta Sans (`next/font/google`) with tabular numeric alignment for registration numbers, queue counts, and timestamps.
* **Micro-Interactions**: Tactile press scaling (`scale(0.98)`), solid high-contrast toast notifications, smooth focus rings (`ring-emerald-500/40`), and `prefers-reduced-motion` compliance.
* **Accessibility**: WCAG 2.2 AA, held on all new UI — 44×44 minimum touch targets, contrast that survives bright outdoor light, visible focus rings, and text scaling. Measured by the Playwright a11y suite, not by eye.
* **Design Philosophy**: High polish, high contrast for field visibility, mobile-first with a verified desktop print path, minimal diffs, and zero unnecessary friction.

## Navigation

Every page's dock is **role-aware**, built from one helper. No page may offer a link
that bounces the current role, and every page offers a valid way home. `roleHome()` in
`src/lib/roles.ts` is the single routing table — pages must call it rather than
hardcoding their own redirects.

Error handling is **per-section**: a failed query renders an inline retry card in that
panel only, and the rest of the desk stays usable. A page-level `throw` takes the whole
screen down over one bad query and is not acceptable on a desk running a live camp.

## Document Authority Precedence

When governing documentation conflicts, resolve in this order:

1. **`docs/adr/`** — architectural decision records. [ADR 0008](docs/adr/0008-printing-queues-the-patient.md) defines the current architecture.
2. **`CONTEXT.md`** — ubiquitous language, domain context, lifecycle invariants, role boundaries, design-system rules.
3. **`README.md`** — operations, deployment, build/verify gates, auth model, MSG91 configuration.

## Production Safety & Realtime Boundaries

* **Production Data Safety**: **Production is NEVER assumed to be empty.** Running `db reset` or re-applying baseline SQL against production is strictly prohibited. Schema changes must use append-only incremental migrations validated via clean replay on disposable databases. The one-time destructive migration `20260728119000` was an explicitly authorised exception taken while production held only test data; that exception does not generalise.
* **Realtime Boundary**: Public patient Realtime channels are retired. The `patients` table is strictly absent from the `supabase_realtime` publication (`patients_realtime_absent` check).
* **Polling**: Queue, seat board, and desk updates use manual Refresh or fixed polling — zero public WebSocket channels on patient rows.
* **Least Privilege**: Desk operations run under SQL role predicates. `is_staff()` — and its alias `is_camp_crew()` — gate every desk RPC. Patients do not sign in and hold no Supabase Auth sessions.
* **Status Token Boundary**: Passwordless `/s/<token>` provides public status tracking via the `patient_status_by_token` RPC, which is **service-role only** and returns non-sensitive queue metrics with PII, phone, address and Aadhaar details stripped.

## Testing & Evidence Governance

* Brittle source-text regex assertions are discouraged; tests should assert empirical runtime behaviour across four seams:
  1. `node:test` behavioural unit suite (`tests/*.test.mjs`)
  2. Database integration suite (`tests/*.db.test.mjs`)
  3. Playwright role e2e suite (`e2e/*.spec.ts`)
  4. Full gate (`npm run verify`)
* **A skipped database test is a failure, not a pass.** `npm run test:db` fails the run on any skip and names it a blocker. Test files must skip only when the database is genuinely unreachable — a guard that treats a *missing RPC* as "Postgres unavailable" silently deletes coverage exactly when a migration breaks something, which has happened here before.
* **A green suite is not evidence the app works.** Every defect found in the July 2026 audit passed the full suite. Verify behaviour against a running app, not against a summary line.
