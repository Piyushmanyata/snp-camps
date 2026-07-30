# Desk Registration, Fulfilment Slips, KPI Integrity, and Print Templates

## Status

Requirements discovery in progress. No implementation is approved yet.

## Task Triage

**Substantial / high-risk.** The request changes staff permissions, patient identity
capture, database-enforced workflow rules, KPI attribution, physical printing, and
admin-controlled document layouts across multiple application and database boundaries.

## Project Completion Goal

Deliver a safe camp workflow in which staff collect a required household contact
number before Aadhaar capture, volunteers register patients only from successful
Aadhaar scans, Team Leads alone can use an audited manual-registration exception, a new
clinical fulfilment role records required prescription data and either fulfils or
defers the patient, deferred patients receive the correct 2-inch spectacles or OT slip,
leaderboard numbers resist self-attribution abuse, and admins can safely edit the
prescription presentation.

The project is complete only when the role and lifecycle rules are enforced by trusted
server/database boundaries, the required print outputs fit their confirmed physical
media, unit/database/e2e/accessibility checks pass without skipped database tests, and
the critical workflows are verified against a running application.

### In Scope

- Required contact phone captured before Aadhaar scanning on desk registration.
- Shared household phone numbers; phone is not a patient identity key.
- Aadhaar-scan-only volunteer registration.
- Audited Team Lead manual-entry exception after failed scans.
- A new **Clinical Desk Operator** (`clinical_operator`) role that scans the Patient QR
  or enters the registration number, transcribes the required fields from the doctor's
  paper prescription, and chooses fulfil or defer.
- Independent Medicine, Specs, and OT fulfilment items, with two separate 2-inch
  deferred slips only for Specs and OT using the matching camp-configured date/venue.
- Anti-gaming rules for volunteer and Team Lead KPI/leaderboard attribution.
- Admin-editable prescription sponsors and approved layout controls.
- Incremental migrations, documentation, tests, and browser/print evidence.

### Out of Scope

- A Doctor login/station, unless later explicitly selected as the new role.
- Aadhaar eKYC, OTP, or online UIDAI verification.
- Treating a shared phone number as a unique patient identifier.
- Adding another patient queue state beyond `registered → waiting → seen`.
- Destructive production schema resets or baseline migration edits.

### Constraints

- Production data is presumed to exist; schema changes are append-only migrations.
- The paper prescription remains the clinician's working record; the exact authority
  and scope of the newly restored digital prescription data is still open.
- Patient QR remains a staff-scan identifier, never a login credential.
- Staff UI is English and must meet WCAG 2.2 AA.
- The smallest correct design should reuse the existing scanner, print, role, and camp
  settings infrastructure.

### Completion Evidence

- Focused unit and database tests for every new invariant.
- Role-based Playwright coverage for volunteer, Team Lead, and admin paths.
- Print PDFs/screenshots at the confirmed media dimensions.
- Full `npm run verify` output with explicit database skip count.
- Requirements traceability and final diff/adversarial review.

## Repository Brief

- Next.js 16.2.11 and React 19.2.8 frontend; Supabase/Postgres authorization and
  lifecycle RPCs; Vercel deployment.
- Current patient lifecycle is exactly `registered → waiting → seen`.
- Printing the A4 prescription queues a registered patient; `mark_seen` records the
  staff member who scans the patient out.
- Desk registration is already Aadhaar-first, but every staff role currently sees a
  manual-entry escape and phone remains optional.
- Aadhaar cards provide no phone number. The current domain already defines phone as a
  household contact and permits family members to share it.
- The current KPI is distinct patients for whom a staff member is `created_by` or
  `checked_in_by`; Team Lead totals roll up their current volunteers.
- Camp settings already store spectacles collection date/venue and post-camp surgery
  date/venue.
- The prescription template model already supports one sponsor logo/label, clinical
  labels, section order/heights, footer text, and letterhead URLs, but the current admin
  settings UI does not expose those template controls.
- ADR 0008 keeps the volunteer desk at exactly two actions. ADR 0009 places the
  post-seen operational transcription and fulfilment workflow at a separate Clinical
  Desk without adding a queue state or a doctor-authored digital prescription.

## Domain Language

- **Deferred fulfilment slip** (confirmed): one of two separate 2-inch instruction
  slips—**Spectacles** or **OT**—printed only when the new fulfilment role defers the
  patient. It contains the matching admin-configured date/venue and patient identity,
  registration number, and Patient QR.
- **Fulfil** (confirmed): the new role records the required prescription data and
  completes the applicable service without issuing a deferred fulfilment slip.
- **Defer** (confirmed): the new role records the required prescription data, selects
  Spectacles or OT, and issues the matching deferred fulfilment slip for later service.
- **Clinical Desk Operator** (confirmed): a trained operational role that transcribes
  the doctor's paper prescription into the app and records fulfil/defer decisions. The
  operator is the data-entry author, not necessarily the prescribing clinician.
  _Avoid_: Doctor, Counter Operator.
- **Manual registration exception** (confirmed): a Team Lead/admin-only, audited fallback
  after documented Aadhaar scan failures; it is not a normal registration mode.
- **Household contact phone** (confirmed): the required contact number collected
  before scanning; several Persons may share it and it never defines identity.

These terms are recorded in `CONTEXT.md`.

## Decision Ledger

| ID | Decision | Status | Evidence / reason |
|---|---|---|---|
| D1 | Keep the three-state patient lifecycle unchanged. | Accepted | Governing ADR 0008 and `CONTEXT.md`; slips are post-seen output, not state. |
| D2 | Enforce phone sequence and role permissions on trusted boundaries, not UI alone. | Accepted | Prevents forged client calls and satisfies anti-gaming intent. |
| D3 | Use two separate 2-inch deferred fulfilment slips: Spectacles and OT. | Accepted | User clarified physical size and variants. |
| D4 | Only the Clinical Desk Operator (`clinical_operator`) can transcribe prescription fields and choose fulfil or defer; defer requires Specs or OT and prints the corresponding slip. | Accepted | The operator is attributed as data-entry author, not as the prescribing doctor. The fields, item outcomes, locking, corrections, and follow-up behavior are defined below. |
| D5 | Volunteers never receive manual identity fields. After three failed Aadhaar scan attempts, the UI shows “Ask Team Lead.” A Team Lead or admin must use their own account, select a failure reason, and manually register; the database records actor, timestamp, reason, and attempt count. Clinical Desk Operators cannot use this path. | Accepted | Server enforcement prevents a volunteer from forging the fallback. |
| D6 | A registration earns exactly one final leaderboard point for its original registrar only after that patient reaches `seen`. Walk-ins are eligible. Printing, reprinting, mark-seen action, clinical transcription, fulfilment, and repeated scans earn nothing; credit is immutable and one Registration contributes at most one point. Audited manual failed-scan registrations do not earn competitive credit. | Accepted | Replaces the pumpable `created_by OR checked_in_by` activity union with an outcome-qualified registrar count. |
| D13 | Before the first camp day, rank by valid non-manual Registrations generated. From the first camp day onward, rank by “Seen from your registrations” while retaining “Registered” as a secondary column. Manual fallback registrations are excluded from both competitive metrics. | Accepted | Preserves pre-camp motivation without misrepresenting registrations as completed attendance. |
| D14 | The ten-minute `undo_mark_seen` path remains available only while no Prescription Transcription exists. Starting clinical transcription locks the patient out of queue reversal; later changes require an admin-authored, reasoned correction. | Accepted | Prevents a patient returning to `waiting` after clinical fulfilment work has begun. |
| D15 | Defer fails closed when the matching Specs or OT admin date/venue is incomplete. Prescription saving and other fulfilment items may continue, but no deferred record or slip is created until configuration is complete. | Accepted | Prevents patients receiving unusable blank instructions. |
| D16 | Each 2-inch slip prints camp name, a large Specs/OT heading, patient name, registration number, age/gender, deferred date/venue, Patient QR, issue timestamp, and slip reference/version. It excludes address, Aadhaar, prescription measurements, and full phone. | Accepted | Keeps the narrow slip legible and privacy-minimized. |
| D17 | Clinical lookup, transcription, fulfilment and defer mutations are available only for patients whose Registration is already `seen`; enforce on the trusted database/RPC boundary. | Accepted | Original requirement; UI-only gating is insufficient. |
| D7 | Use a structured, print-safe prescription template editor. Admins may add/remove/reorder multiple sponsor logos; reorder approved blocks; edit labels, visibility, and bounded writing heights; preview A4 live; save draft, publish, and restore defaults. Reject layouts exceeding one page. Patient identity, registration number, and QR remain fixed. | Accepted | Avoids overlap and broken camp-day prints while meeting layout-control needs. |
| D8 | Medicine, Specs, and OT are independent fulfilment items. Medicine outcomes are fulfilled, not available, or not required. Specs and OT outcomes are fulfilled, deferred, or not required. Only deferred Specs/OT print slips, so one patient may receive zero, one, or two slips. | Accepted | Supports prescriptions with any combination, including no fulfilment required. |
| D18 | Medicine dispensed at camp and fixed-power Specs handed over at camp are recorded as fulfilled. | Accepted | User clarified same-day fulfilment examples. |
| D19 | Unavailable medicine is recorded as `not_available` for follow-up and prints no slip. Every item also supports `not_required`, allowing a transcription with no fulfilment work. | Accepted | Only Specs and OT have configured deferral instructions. |
| D20 | USB keyboard-wedge QR hardware is dedicated to Aadhaar capture on the registration laptop. Clinical Desk Patient QR lookup continues through the camera scanner or typed registration number. A physical-device compatibility gate must prove the selected scanner emits complete Aadhaar Secure QR payloads. | Accepted | Generic QR support alone does not prove Aadhaar payload compatibility. |
| D21 | After opening a current Registration, a Clinical Desk Operator may view read-only prior prescription/fulfilment history for the same Person but edit only the current Camp record. Clinical Operators have no broad patient search/export; admins may review and export for authorized follow-up. | Accepted | Enables continuity without granting bulk clinical-data access. |
| D22 | Saving a Specs/OT defer decision creates one versioned slip and immediately opens printing. Clinical Desk Operators and admins may reprint the active version without creating a new deferral. A correction cancels the old version and creates a replacement; cancelled versions remain audit-only and are not valid print targets. | Accepted | Makes print retries idempotent and corrections traceable. |
| D23 | An issued deferred slip snapshots its date and venue. Later admin setting changes affect only future deferrals; changing an issued patient's instructions requires an explicit correction and replacement slip. | Accepted | Prevents previously issued instructions changing silently. |
| D24 | Remove phone-only likely-duplicate warnings. Shared household phones never warn, block, or require override. Aadhaar-derived Person identity remains the hard duplicate control; name-and-age remains a secondary warning. | Accepted | Aligns duplicate handling with mandatory shared household contacts. |
| D25 | Retain prescription, fulfilment, correction, and slip history across Camps. Admins may archive records from routine views, but normal UI provides no hard delete and audit history remains preserved unless a separately reviewed legal/privacy policy requires deletion. | Accepted | Supports future assistance while preventing casual destruction of clinical history. |
| D26 | Prescription sponsor assets are admin-uploaded PNG, JPEG, or WebP files up to 2 MB, fitted into bounded sponsor blocks and served through a safe managed print-asset path. Reject SVG and arbitrary external URLs. | Accepted | Avoids script/tracking risk and unreliable external print assets. |
| D27 | A deferred Specs/OT item may later transition to fulfilled with operator and timestamp attribution. Preserve the original defer/slip history, disable active-slip reprints after fulfilment, and require an admin correction for reversal. | Accepted | Supports later service without rewriting the original decision. |
| D28 | Clinical Desk Operators have a narrow follow-up mode for unresolved deferred Specs/OT items from inactive Camps. Exact Patient QR or registration-number lookup reveals only that Person's unresolved items; operators may fulfil them but cannot edit the historical prescription. | Accepted | Enables later service without broad historical write access. |
| D29 | Medicine marked not available also appears in Clinical follow-up mode and may later transition to fulfilled without a slip. Preserve the unavailable event and attribute the later dispensing operator/timestamp. | Accepted | Supports medicine follow-up consistently without inventing a third slip. |
| D30 | Do not store prescription or fulfilment PHI offline. During an outage retain the paper prescription and an explicit retry state; create deferred records and print slips only after successful server persistence. | Accepted | Prevents untracked slips and sensitive data remaining on shared laptops. |
| D9 | Store a structured operational transcription of the doctor's paper prescription: diagnosis option(s) plus Other; optional blood sugar, BP, remarks/advice, and medicines; Specs type plus RE/LE distance sphere, cylinder, axis, vision, near addition/sphere, and pupillary distance; OT eye, diagnosis/procedure, and notes. Operator and timestamp are automatic. Relevant item fields become required when Specs or OT is selected. | Accepted | Paper remains the prescribing source; the database copy supports follow-up and fulfilment. |
| D10 | Clinical Desk Operator is a station-only role. It cannot register patients, print the original A4 prescription, mark seen, manage staff, or access leaderboards. Admins manage its accounts and may review records; Registration Staff cannot access clinical records. | Accepted | User confirmed least-privilege boundary. |
| D11 | Prescription transcription is freely editable before any fulfilment item is resolved. The first fulfil/defer decision locks the original record. Later changes are append-only corrections by a Clinical Desk Operator or admin with mandatory reason, timestamp, author, and cancellation/replacement history for any superseded slip. | Accepted | Preserves clinical and operational auditability without silent overwrite. |
| D12 | Desk registration requires a valid 10-digit Indian household contact number before the Aadhaar scanner can open. Unlimited patients may share it; dummy repeated-digit values are rejected; no role may bypass it. Phone remains a contact attribute, never an identity or uniqueness key. | Accepted | Covers family phone sharing while preventing blank or obviously fabricated contacts. |

## Capability and Context Mode

- Harness mode: single-agent for planning; sub-agent delegation is not user-authorized.
- Ponytail: full, favouring reuse of existing scanners, role checks, JSON template, and
  print route.
- Graphify: existing graph queried, then critical claims verified against source.
- LeanCTX: CLI compression available; configured rules file is missing, so planning is
  operating in degraded mode with focused reads and compressed shell output.

## Provisional Skill Manifest

| Skill | Purpose | Phase | Expected output |
|---|---|---|---|
| grill-with-docs + grilling | Resolve material product decisions one at a time. | Discovery | Confirmed decision ledger and shared understanding. |
| domain-modeling | Maintain precise camp terminology and sparing ADRs. | Discovery / plan | Updated glossary and any justified ADR. |
| graphify | Map affected modules and dependencies. | Reconnaissance / review | Source-backed change-impact map. |
| ponytail | Minimize new concepts and reuse current infrastructure. | All phases | Smallest safe design. |
| supabase + Postgres best practices | Design role, audit, migration, and KPI enforcement. | Plan / execution | Append-only, least-privilege database changes. |
| Next.js / React best practices | Implement role-aware desk and admin surfaces. | Execution | Compatible server/client UI changes. |
| accessibility + browser verification | Validate desk UX and print flows. | Verification | WCAG and role-based browser evidence. |

## Open Interview

Questions are asked one at a time. Each accepted answer will update this document
immediately.
