# SNP Camps — Domain Context & Ubiquitous Language

The app moves a patient through the live line: **registered → waiting → seen**, then
supports a separate Clinical Desk for fulfilment and follow-up. The doctor's handwritten
paper prescription remains the prescribing source of truth; the Clinical Desk stores an
operational transcription and immutable fulfilment history. See
[ADR 0008](docs/adr/0008-printing-queues-the-patient.md) and
[ADR 0009](docs/adr/0009-clinical-desk-operational-records.md).

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
* **Registration Staff**: An admin, team lead, or volunteer. Runs the registration desk: register, print, mark seen, and change camp day. Current predicates: TypeScript `isStaff`, SQL `is_staff()`.
  _Avoid_: Using this term for a Clinical Desk Operator, whose clinical transcription permissions are separate.
* **Camp crew**: The umbrella for operational login roles at a Camp. It includes Registration Staff and the Clinical Desk Operator, but each station retains least-privilege permissions. The current `isCampCrew` / `is_camp_crew()` aliases predate the Clinical Desk Operator and must not be used to grant its clinical writes broadly.
* **Team Lead**: A login role with every volunteer power, plus the ability to create volunteers onto their own team and to see their team's rolled-up numbers. Created **only** by an admin; a Team Lead may never mint any role other than `volunteer`. A Team Lead works the same desk as a volunteer — `/volunteer` is their home, with a team panel added on top.
  _Avoid_: "Team member" — every role is a member of the team; this term names the supervisory relationship.
* **Clinical Desk Operator**: A trained, station-only operational login role that transcribes the doctor's paper prescription into the app and records whether Specs or OT is fulfilled or deferred. The operator is attributed as the data-entry author and is not represented as the prescribing clinician. Clinical Desk Operators cannot register patients, print the original A4 prescription, mark patients seen, manage staff, or access leaderboards; Registration Staff cannot access clinical records.
  _Avoid_: Doctor, Counter Operator.
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
* **Undo mark seen**: `undo_mark_seen` reverses a mis-scan within **ten minutes** only while no Prescription Transcription exists, restoring `waiting` on the patient's original `queued_at` so they do not go to the back of the line. Starting clinical transcription locks queue reversal; later changes require an admin-authored, reasoned correction.
* **Walk-in vs pre-reg**: Registering on an **active Camp Day (today, Asia/Kolkata)** and printing puts the patient in line in one desk visit. Registering for a future day stays `registered` and prints nothing. **No desk mode toggle** — the system uses the camp day date.
* **Volunteer Desk**: The one station staff operate (`/volunteer`; admins get the same surface on `/admin`). Two big buttons — **Print prescription** and **Mark seen** — with the live queue below; each button opens scan-or-type. Mobile-first, because phones do the scanning and a laptop does the printing. The **only** place walk-ins are registered (online self-registration covers pre-registration only).
* **Self-registration**: Patient self-service registration online by scanning the QR on their Aadhaar card (`/self-register`). Queue status is **ALWAYS `registered`** (NEVER `waiting`), even when registering for today's camp day, preserving the invariant that `waiting` means physically present in the hall. Requires no SMS, no OTP, and no eKYC provider configuration.
* **Aadhaar scanned**: Details were read from the QR on a physical Aadhaar card and are assumed authentic — **no** signature check and **no** OTP is performed, so this asserts provenance of the *data*, not confirmation of *identity*. Absence of a scan is normal for walk-ins typed in at the desk and indicates self-declared details.
  _Avoid_: "Aadhaar verified", "eKYC verified" — the system verifies nothing.
* **USB Aadhaar scanner**: The keyboard-wedge QR device attached to the registration laptop solely for reading the Aadhaar card QR after a Household contact phone is accepted. It is not the Clinical Desk Patient QR scanner, and a model is supported only after a physical test proves it emits the complete Aadhaar Secure QR payload.
* **Contact phone rule (Self-registration)**: The Aadhaar QR carries no phone number, so a self-registering patient types one and it is **self-declared and unverified**. Because the registration SMS embeds a live status link, **self-registration sends no registration SMS** — the confirmation screen showing registration number, patient QR, camp day, venue and status link is the receipt. A database trigger enforces this; it is not left to application code.
* **One-Person-per-Aadhaar**: Globally enforced uniqueness of one Person per Aadhaar card, keyed on `HMAC-SHA256(last4 + normalised name + DOB + gender)` — **not** on phone number (family members in a household frequently share one mobile) and **not** on the full 12-digit number (the card QR yields only last-4). Applies to every scanned path, self-service and desk alike, with no override. Scanning the same card again returns the existing Person's registration number and status link rather than creating a duplicate; within an active Camp it also returns their existing Registration.
  _Avoid_: "One-per-Aadhaar-per-Camp" — uniqueness is global, not per Camp.
* **Prescription Sheet**: The printed form, and the camp's clinical record. Pre-filled with **venue, name, address, registration number, date, age, M/F and contact number** — identity only. Every clinical field (diagnosis checkboxes, blood sugar, BP, remarks, medicines, the glasses-prescription table) is left blank for handwriting. Carries the Patient QR top-right beside the Reg. No. box. **No e-mail field.** The whole form prints on every sheet, on plain paper.
* **Prescription Transcription**: The structured operational copy entered by a Clinical Desk Operator from the doctor's completed paper Prescription Sheet after the patient is marked seen. It records diagnosis option(s) plus Other; optional blood sugar, BP, remarks/advice, and medicines; Specs measurements when Specs is selected; OT eye, diagnosis/procedure, and notes when OT is selected; and automatic operator/timestamp attribution. The paper remains the prescribing source.
  _Avoid_: Digital prescription, Doctor-authored record.
* **Prescription Correction**: An append-only, reasoned amendment added by a Clinical Desk Operator or admin after a fulfilment decision locks the original Prescription Transcription. It records author and timestamp and may cancel and replace an incorrect deferred slip without erasing the original decision.
  _Avoid_: Editing history, overwriting a resolved prescription.
* **Clinical history**: Read-only prior Prescription Transcriptions and fulfilment outcomes for the same Person, revealed to a Clinical Desk Operator only after opening that Person's current Registration. Clinical Operators edit only the current Camp record and receive no broad patient search or export; admins may review and export for authorized follow-up.
* **Clinical archive**: Prescription, fulfilment, correction, and slip history retained across Camps for continuity. Admins may archive records from routine views, but normal UI provides no hard delete and audit history remains preserved unless a separately reviewed legal/privacy retention policy requires deletion.
* **Clinical outage rule**: Prescription and fulfilment PHI is never stored offline on a desk device. During an outage the paper Prescription Sheet remains the recovery source; deferred records and slips are created only after a successful server save.
* **Prescription template**: A per-camp, versioned, print-safe block configuration. Admins may add, remove, and reorder multiple sponsor logos; reorder approved clinical blocks; edit labels, visibility, and bounded writing-area heights; preview the A4 result; save drafts, publish, and restore defaults. A template that exceeds one A4 page cannot be published. Patient identity, registration number, and Patient QR are fixed and not editable.
  _Avoid_: Free-position canvas, unrestricted drag-and-drop.
* **Sponsor asset**: An admin-uploaded PNG, JPEG, or WebP image up to 2 MB, served through the app's managed print-asset path and fitted into a bounded sponsor block. SVG and arbitrary external image URLs are not accepted.
* **Fulfilment item**: One independent Medicine, Specs, or OT requirement attached to a Prescription Transcription. A prescription may contain any combination. Medicine resolves to fulfilled, not available, or not required; Specs and OT resolve to fulfilled, deferred, or not required. Medicine dispensed at camp and fixed-power Specs handed over at camp are fulfilled; only deferred Specs and OT print slips.
* **Deferred fulfilment slip**: One of two separate 2-inch instruction slips — **Specs** or **OT** — printed by a Clinical Desk Operator only after the corresponding fulfilment item is deferred. It carries camp name, service heading, patient name, registration number, age/gender, matching admin-configured date/venue, Patient QR, issue timestamp, and slip reference/version. It excludes address, Aadhaar, prescription measurements, and full phone. A patient with both items deferred receives two slips.
* **Active slip version**: The one valid printable version of a Deferred fulfilment slip. Reprinting is idempotent and reuses it; a reasoned correction cancels it and issues a replacement, while the cancelled version remains audit-only and cannot be printed as valid.
* **Deferred follow-up fulfilment**: The later transition of a deferred Specs or OT item to fulfilled, attributed to the Clinical Desk Operator and timestamp. The original deferral and slip remain in history, active-slip reprinting stops, and reversal requires an admin correction.
* **Clinical follow-up mode**: A narrow Clinical Desk surface for exact Patient QR or registration-number lookup of unresolved items from inactive Camps. It reveals only that Person's deferred Specs/OT and not-available Medicine items and permits later fulfilment, not editing of the historical Prescription Transcription. Medicine follow-up prints no slip.
* **Slip instruction snapshot**: The deferred date and venue copied into an issued slip version. Later Camp-setting changes affect only future deferrals; an issued patient's instructions change only through a reasoned correction and replacement slip.
* **Clinical eligibility**: A Clinical Desk Operator may look up and mutate clinical records only for a Registration already in `seen`. The database enforces this boundary; scanning or typing an ineligible patient returns a clear refusal without exposing clinical data.
* **Deferral readiness**: A fulfilment item may be deferred only when its matching admin-configured date and venue are both present. Missing configuration blocks that deferral and its slip without blocking transcription saving, fulfilment, or the other item.
* **Letterhead**: One committed **image**, not typeset text — the header carries Devanagari and Bengali script that would silently break on any printing machine lacking those fonts (ADR 0008).
* **Aadhaar lock**: On a successful Aadhaar scan the identity fields — legal name, DOB, gender, last-4 — become read-only and cannot be edited by any role, because they compute the duplicate key. Phone, address and camp day stay editable. When the scanned name is non-Latin the volunteer must supply a separate Latin **display name** for the printed form and for name-search; the duplicate key always uses the verbatim scanned name, so a transliteration typo cannot create a second Person.
* **Manual registration exception**: An audited fallback available only to a Team Lead or admin after three failed Aadhaar scan attempts. The authorized actor uses their own account and records a failure reason; the Registration stores actor, timestamp, reason, and attempt count. Volunteers never receive manual identity fields, and Clinical Desk Operators cannot register.
  _Avoid_: Manual mode, skip scan.
* **Household contact phone**: The valid 10-digit Indian mobile number collected before the Aadhaar scanner can open during desk registration. It is mandatory with no role bypass, but unlimited Persons may share it; obvious dummy repeated-digit values are rejected.
* **Phone number → patient relationship**: A phone number identifies a *household*, not a Patient. A Patient is identified by registration number. Several family members may share one phone for contact/SMS; the phone is never an identity or uniqueness key, and PHI is scoped to the registration and status token, never to "whoever has this phone."
* **Name-search**: For patients who pre-registered, lost their paper, forget the number, and gave no phone. Prefix match on normalised name (case-folded, whitespace-collapsed), active camp, **`registered` only**; rows show name, age, and address (locality).
* **Leaderboard point**: One point awarded to the original registrar of a Registration only when that Patient later reaches `seen`. Walk-ins are eligible. Printing, reprinting, marking seen, clinical transcription, fulfilment, and repeated scans award nothing; attribution never changes and one Registration contributes at most one point.
  _Avoid_: Patients handled, action count.
* **Pre-camp registration count**: A motivational count of valid, non-manual Registrations attributed to their original registrar before attendance is known. It is displayed separately from Leaderboard points and never presented as completed patient throughput.
* **Volunteer / staff KPIs**: One function (`staff_person_kpis`) defines a volunteer's active-camp numbers for both the desk and the admin staff panel. Competitive credit belongs only to the original registrar. Before the first Camp Day it counts eligible non-manual Registrations; from the first Camp Day onward the primary metric is eligible registrations that reached `seen`, with Registered retained as a secondary count. **With no active camp, every metric is zero** — not an all-time career total, not null.
* **Team KPI rollup**: A Team Lead's competitive total is the sum of eligible original-registrar credits belonging to the lead and volunteers currently linked to that lead, under the same pre-camp/live-camp rule. Operational distinct-patient counts may still exist for capacity reporting, but they are not leaderboard points and must not be presented as such.
* **Leaderboard**: Two separate active-camp rankings — one of Team Leads and one of individual volunteers. Before the first Camp Day they rank by Pre-camp registration count. From the first Camp Day onward they rank by Leaderboard points and retain Registered as a secondary column. Manual registration exceptions are excluded from both competitive metrics. The Team Lead board shows team headcount beside each row, because absolute throughput naturally favours larger teams. Visible in full to Registration Staff; exposes aggregate counts only, never patient PII.
* **Seat caps**: Enforced for **pre-registration only**. A walk-in physically standing at the desk is never turned away because a day is notionally full.
* **Aadhaar last-4 + name uniqueness**: Within one Camp, the pair *(Aadhaar last 4 digits, normalised full name)* is unique for non-overridden registrations. Two different people can share a common name and the same last four digits; a hard block at the desk is unacceptable. On conflict the system names the **conflicting registration number**. Staff may take an explicit, one-shot **override**; the new registration records who overrode and when. Override is never sticky, never automatic, never available outside desk registration.
* **Likely-duplicate soft warn** (not a hard unique): At desk submit, within the **active Camp only**, if another patient matches **normalised name + age**, the RPC raises `LIKELY_DUPLICATE:reg=N`. The form shows one Hinglish sentence and two actions: **Print for them instead** (primary — abandons the new registration and queues the existing one) or **Register anyway** (one-shot override with audit columns). Phone-only matches never warn because a Household contact phone is deliberately shared. Never blocks; never as-you-type. Aadhaar uniqueness is separate and still hard.

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

1. **`docs/adr/`** — architectural decision records. [ADR 0008](docs/adr/0008-printing-queues-the-patient.md) defines the live desk and queue; [ADR 0009](docs/adr/0009-clinical-desk-operational-records.md) defines the post-doctor Clinical Desk.
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
