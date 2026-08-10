# Prescription recording and Camp records export

## Problem Statement

An admin maintaining a Camp's records has one export button, on the admin clinical
records screen, and it does not produce a usable record of the Camp.

* **It exports whatever happens to be on screen.** The screen loads 50 Prescription
  Transcriptions at a time. An admin who clicks Export without clicking "Load more"
  receives the 50 most recent rows in a file that looks complete. A 520-patient Camp
  silently exports as 50 patients.
* **It is not readable.** Three of its eight columns are raw JSON. The whole clinical
  record — diagnoses, blood pressure, blood sugar, spectacle powers, OT procedure — is
  compressed into one JSON cell. Nothing can be sorted, filtered, or counted. Asking
  "how many patients had cataract" or "what were the average spectacle powers" is
  impossible without hand-parsing.
* **It quietly omits patients.** Only patients with a saved Prescription Transcription
  appear. A Patient who reached `seen` but whose paper was never transcribed at the
  Clinical Desk does not exist in the file, and the admin has no way to tell a
  transcription backlog from a healthy patient.
* **It breaks on the data this Camp actually holds.** Patient names are in Devanagari
  and Bengali. The file has no byte-order mark, so those names open as mojibake in
  Excel on Windows. Timestamps are ISO-8601 UTC, so an evening transcription in Sikar
  reads as the previous day.
* **It returns an empty file when no Camp is active,** with no error, because the
  underlying function resolves a null camp to "the active Camp" and there isn't one.

Separately, the recording side has two defects that corrupt the record before it is
ever exported:

* **Editing a Prescription template rewrites history.** The distinction between a
  checked diagnosis option and free-text "Other" is not stored. It is recomputed on
  every read against the template's *current* option list. Remove or rename an option
  and every past Prescription Transcription that used it silently re-reads as free
  text; add an option and past free text retroactively becomes a checkbox.
* **"Medicine not available" names no medicine.** Medicine is a Fulfilment item that
  resolves to `not_available`, but the prescription itself is one free-text paragraph.
  The system therefore records that *something* ran out, with no way to say what.

## Solution

Two separate downloads, each honest about what it is, plus the recording fixes that
make them trustworthy.

**Camp Records Export** — a flat working spreadsheet. One row per Patient who reached
`seen` in one Camp, complete regardless of what is loaded on screen. Every clinical
field is its own column: one indicator column per diagnosis option from that Camp's
published Prescription template, spectacle powers as real numbers, blood pressure,
blood sugar, remarks, medicines, Fulfilment item outcomes. It opens correctly in Excel
with Devanagari names intact and timestamps in Asia/Kolkata. Patients seen but not yet
transcribed appear with identity columns filled and clinical columns blank, so the
transcription backlog is visible by sorting one column.

**Clinical Audit Export** — a separate flat list, one row per append-only event:
Prescription Corrections, Fulfilment item resolutions and reversals, and Deferred
fulfilment slip issues and cancellations. Columns are who, what, when, from, to, and
why. No JSON.

**Recording fixes** — a Prescription Transcription stores what the Clinical Desk
Operator actually asserted (these options, plus this Other text) rather than
recomputing it later, so editing a template can no longer alter historical records.
And when a Clinical Desk Operator resolves the Medicine Fulfilment item as
`not_available`, they itemise which medicines were unavailable, turning an unanswerable
question into a column.

## User Stories

1. As an admin, I want the export to contain every Patient in the Camp, so that I do not file an incomplete record believing it is complete.
2. As an admin, I want the export to be independent of how many times I clicked "Load more", so that two admins exporting the same Camp get the same file.
3. As an admin, I want one row per Patient, so that counting rows counts patients.
4. As an admin, I want to choose which Camp I export, so that I can produce records for a Camp that has already ended.
5. As an admin, I want the export to default to the active Camp, so that the common case takes no configuration.
6. As an admin, I want a clear error when I export with no active Camp and no Camp chosen, so that I never mistake an empty file for a Camp with no patients.
7. As an admin, I want each diagnosis option in its own column marked yes or blank, so that I can count patients per diagnosis with a spreadsheet formula.
8. As an admin, I want the diagnosis columns to come from the Camp's published Prescription template, so that an option nobody selected still appears as a column of blanks rather than vanishing.
9. As an admin, I want free-text "Other" diagnoses in their own column, so that they are never confused with template options.
10. As an admin, I want spectacle powers as real numbers, so that I can sort, filter, and average them.
11. As an admin, I want negative spectacle powers to arrive as numbers and not as text with a stray apostrophe, so that arithmetic works.
12. As an admin, I want patient names in Devanagari and Bengali to render correctly when I open the file in Excel, so that the record is legible.
13. As an admin, I want timestamps in Asia/Kolkata, so that an evening transcription is filed on the day it happened.
14. As an admin, I want the household contact phone to stay exactly as recorded, so that Excel cannot reformat or truncate it.
15. As an admin, I want the phone column named as a household number, so that nobody reading the file later mistakes it for a per-Patient identifier.
16. As an admin, I want age and gender columns, so that clinical values can be interpreted.
17. As an admin, I want the address column, so that I can identify patients by locality when following up.
18. As an admin, I want Aadhaar details and date of birth to never appear in any export, so that a downloaded spreadsheet cannot reconstruct the identity key.
19. As an admin, I want Patients who reached `seen` but were never transcribed to appear with blank clinical columns, so that the transcription backlog is visible.
20. As an admin, I want to sort by the transcription timestamp column and see untranscribed patients group together, so that the export doubles as a work list.
21. As an admin, I want the export to reflect the effective Prescription Transcription after any Prescription Correction, so that the file shows the corrected clinical record rather than a superseded one.
22. As an admin, I want to include or exclude archived records, so that the routine export is clean and the complete one is still available.
23. As an admin, I want each Fulfilment item outcome in its own column, so that I can filter the Camp's deferred Specs and OT work.
24. As an admin, I want a separate audit download, so that the working spreadsheet is not polluted with event history.
25. As an admin, I want the audit export to have one row per event with who, what, when, from, to, and why, so that I can read it without parsing JSON.
26. As an admin, I want audit rows attributed to a named person rather than an opaque identifier, so that the trail is readable.
27. As an admin, I want the audit export to identify patients by registration number only, so that it carries less personal data than the records sheet.
28. As an admin, I want both downloads to work for a Camp with thousands of patients, so that the largest Camp is not the one that fails.
29. As an admin, I want the export filename to name the Camp and the date, so that files do not collide in my Downloads folder.
30. As an admin, I want the export buttons to say what they produce, so that I do not have to open a file to learn what is in it.
31. As a Clinical Desk Operator, I want a diagnosis I checked to stay checked when I reopen a record, so that the record does not change under me.
32. As an admin, I want editing a Camp's Prescription template to leave past Prescription Transcriptions unchanged, so that history is not rewritten by a configuration change.
33. As an admin, I want a diagnosis option removed from the template to keep appearing on the records of patients who had it, so that past clinical facts survive template edits.
34. As an admin, I want free text typed as "Other" to stay "Other" even if a matching option is added later, so that records reflect what was actually entered.
35. As a Clinical Desk Operator, I want existing Prescription Transcriptions saved before this change to keep opening correctly, so that no record becomes unreadable.
36. As a Clinical Desk Operator, I want to itemise which medicines were unavailable when I resolve Medicine as not available, so that the record names the shortage.
37. As a Clinical Desk Operator, I want the medicine itemisation to appear only when I resolve Medicine as not available, so that routine transcription stays as fast as it is today.
38. As a Clinical Desk Operator, I want to keep typing the prescription as free text from the paper, so that transcription speed at a live Camp is unaffected.
39. As an admin, I want a column listing the unavailable medicines per Patient, so that I can see what ran out and how often.
40. As an admin, I want only admins to be able to download either export, so that a Clinical Desk Operator cannot extract a Camp-wide patient list.
41. As an admin, I want the export address to reject a non-admin session, so that a guessed link leaks nothing.
42. As a Clinical Desk Operator, I want no export controls on my station, so that my surface stays least-privilege.
43. As an admin, I want a failed export to tell me it failed, so that I never file a truncated or empty file.
44. As an admin, I want the export controls to be keyboard reachable and screen-reader labelled, so that the admin surface stays WCAG 2.2 AA compliant.
45. As a developer, I want the export to be one server-side query per download, so that a partial network failure cannot yield a plausible but short file.
46. As a developer, I want the CSV encoder to distinguish validated numeric fields from operator-authored text, so that formula-injection protection applies where it is needed and nowhere else.
47. As a developer, I want operator-authored text fields to keep formula-injection protection, so that text typed at the Clinical Desk cannot execute when the file is opened.
48. As a developer, I want free-text remarks and medicines containing newlines to survive the round trip, so that multi-line clinical notes are not truncated or split across rows.

## Implementation Decisions

### Two exports, one route

* A single admin route handler serves both files, distinguished by a format parameter:
  the **Camp Records Export** and the **Clinical Audit Export**. Parameters: camp
  identifier (optional, defaults to the active Camp), format, and include-archived.
* The route is gated by the caller's session role being admin, matching the existing
  admin route handlers in this repo. It is not exposed to a service-role key from the
  client. After the session gate passes, the route reads through the service-role
  client, following the established pattern for admin routes.
* Responses are `text/csv; charset=utf-8` with a `Content-Disposition` attachment
  filename naming the Camp and the export date.
* When no camp identifier is supplied and no Camp is active, the route returns an
  explicit error. It must never return a successful empty file. This is a fix for
  existing behaviour, not a new edge case.
* No streaming. A single response body is sufficient at Camp scale, and streaming would
  add failure modes for no benefit.
* The existing paginated admin clinical records function keeps its current job of
  feeding the on-screen list. It is not reused for the export, and its 200-row cap
  therefore does not constrain the export.

### Camp Records Export shape

* **Grain: one row per Patient who reached `seen` in the Camp.** The query is patients
  left-joined to Prescription Transcriptions, not transcriptions joined to patients.
  Patients in `registered` or `waiting` are excluded — a Patient who never attended has
  no clinical record and never will.
* **Effective data.** Where a Prescription Correction of clinical kind exists, the
  latest replacement data is exported, matching what the admin screen already shows.
* **Identity columns:** registration number, patient name, age, gender, household
  phone, address, camp name, and the transcription timestamp. A blank transcription
  timestamp is the signal that a seen Patient has no Prescription Transcription; no
  redundant status column is added.
* **Excluded permanently:** Aadhaar last-4, date of birth, and email. Aadhaar last-4
  together with name, DOB and gender is the full preimage of the One-Person-per-Aadhaar
  key; exporting them together would leak the identity scheme, not just a field. Email
  is excluded because the Prescription Sheet deliberately has no e-mail field.
* **Phone column is named as a household number,** because in this domain a phone
  identifies a household and rows will legitimately share one.
* **Diagnosis columns:** one indicator column per diagnosis option in that Camp's
  published Prescription template, valued yes or blank, plus a separate free-text
  Other column. Columns are derived from the template's option list — not from the
  values present in the data — so an option nobody selected appears as a column of
  blanks. Column layout therefore varies between Camps, which is acceptable because
  each file is Camp-scoped.
* **Clinical columns:** blood sugar, blood pressure, remarks, medicines, unavailable
  medicines, spectacle type, per-eye sphere / cylinder / axis / near / vision, PD, OT
  eye, OT procedure, OT notes.
* **Outcome columns:** one per Fulfilment item kind — Medicine, Specs, OT.
* Deferred fulfilment slip references are not carried in this sheet; slip history
  belongs to the Clinical Audit Export.

### Clinical Audit Export shape

* One row per append-only event, covering Prescription Corrections, Fulfilment item
  resolutions and later fulfilments and admin reversals, and Deferred fulfilment slip
  issues, replacements and cancellations.
* Columns: registration number, entity, event, from-outcome, to-outcome, reason, actor,
  and timestamp. Actor is resolved to the person's name rather than an identifier.
* Patient name is deliberately absent — the registration number joins to the records
  sheet, and the audit file therefore carries less personal data.

### CSV encoding

* The encoder gains a numeric sibling to the existing text cell encoder, and each
  column declares which applies. This is a correctness fix, not a preference: signed
  spectacle powers all begin with `+` or `-` and are currently rewritten with a leading
  apostrophe by the formula-injection guard, which would make every power in the file
  a text cell.
* Numeric columns — registration number, age, blood sugar, spectacle powers, axis, PD —
  are emitted bare after confirming the value is genuinely numeric. Anything that fails
  that check falls back to guarded text rather than being emitted raw.
* Text columns — name, address, remarks, medicines, Other diagnosis, OT procedure and
  notes, audit reasons — keep the formula-injection guard unchanged. These are the
  fields where operator-authored text can arrive.
* Blood pressure stays a text column: it is a systolic/diastolic pair, not a number.
* Excel-first output: UTF-8 with byte-order mark, CRLF line endings, timestamps
  rendered as date and time in Asia/Kolkata rather than ISO UTC, and the household
  phone forced to text so it cannot be reformatted. Multi-line free text is preserved
  inside quoted cells.

### Prescription Transcription: stored diagnosis split

The transcription payload stores the split explicitly instead of recomputing it. Shape:

```
diagnoses: {
  options: string[]   // labels chosen from the Camp's published template
  other: string | null // operator-typed free text
}
```

* Legacy rows hold a flat array of strings. **No destructive backfill.** Production
  safety rules in this repo require append-only migrations, and a backfill would have
  to guess the split using today's template — reintroducing the very drift being fixed.
  Instead, a single shared normalisation function reads either shape and returns the
  explicit one. Legacy rows keep today's behaviour; every new save persists the
  explicit shape.
* That one function is used by the Clinical Desk read path, the validator, the
  correction comparison, and both exports. There must not be a second implementation.
* The validator is extended for the new shape while continuing to accept the legacy
  one, preserving the existing bounds: 1–12 diagnoses, each 1–120 characters.
* The correction-equality check must compare the normalised shape, so that a record
  saved in the legacy shape and re-saved unchanged in the new shape is not treated as
  a change requiring a Prescription Correction.

### Medicine unavailability itemisation

* The itemised list is captured **at the moment the Medicine Fulfilment item is
  resolved as `not_available`**, and is stored with that Fulfilment item and its event
  — not in the Prescription Transcription.
* Rationale, and a refinement made while writing this spec: a fulfilment decision locks
  the Prescription Transcription. Storing the list in the transcription would mean
  either capturing it before the operator knows what is in stock, or forcing a
  Prescription Correction to record a routine dispensing fact. Attaching it to the
  Fulfilment item avoids both.
* The Clinical Desk shows the itemisation input only when the operator selects
  `not_available` for Medicine. Free-text medicines transcription is unchanged.
* Bounded like every other clinical field: a small maximum number of items, each with a
  maximum length, validated server-side as well as in the form.
* The Camp Records Export renders the list as one joined text column.

### Admin UI

* The single "Export loaded records (CSV)" button is replaced by a Camp selector and
  two clearly named buttons — one per export. The existing include-archived toggle
  applies to both.
* Buttons trigger a navigation to the export address rather than assembling a file in
  browser memory. No patient data passes through client state for the purpose of
  exporting.
* The existing accessibility end-to-end suite asserts on the old button's accessible
  name and must be updated in the same change.

### Not changed

* Clinical Desk Operators gain no export capability. The Camp-wide extract stays
  admin-only.
* Exports are not logged. This was considered and explicitly declined by the product
  owner; it is recorded in the ADR so a future reader does not assume it was an
  oversight.

## Testing Decisions

A good test here asserts on what a caller can observe — the bytes of the exported file,
the rows a query returns, the result of validating a payload — and never on how the
code is arranged internally. Assertions on source text or on internal function names
are explicitly discouraged in this repo. Every assertion added for a defect listed in
this spec must be written so that it **fails against the current code** before the fix
lands; an assertion that passes both before and after proves nothing.

**Seam 1 — the export route handler (primary).** Invoke the handler directly in a
`node:test` file and assert on the returned response. Prior art: the existing admin
sponsor-assets, admin staff, and admin team-assignments route tests, which drive route
handlers using the repo's existing next-headers, supabase-ssr and service-role admin
stubs. This seam covers: admin gating and rejection of non-admin sessions; camp
selection and the explicit error when no Camp is active; column layout including
per-option diagnosis indicators derived from the template; bare numeric emission for
negative and positive spectacle powers; byte-order mark; CRLF; Asia/Kolkata timestamps;
household phone forced to text; a Devanagari name surviving the round trip; a seen
Patient with no Prescription Transcription appearing with blank clinical columns;
multi-line remarks surviving quoting; and the audit format's one-row-per-event shape.

**Seam 2 — the database.** A `.db.test.mjs` covering what stubs cannot prove: the
left join that includes seen Patients without a Prescription Transcription, Camp
scoping, the archived filter, and that the latest clinical Prescription Correction wins
over the original transcription data. Prior art: the existing clinical workflow
database test, which seeds profiles, camps, patients and transcriptions directly.
This test must fail loudly if the export function or route is missing. It must not
treat a missing function as "database unavailable" and skip — that guard has silently
deleted coverage in this repo before, precisely when a migration broke something, and
a skipped database test is a failure here, not a pass.

**Seam 3 — the transcription validator (existing).** Extend the existing validator
unit test for the stored diagnosis split: the new shape validates, the legacy flat
array still validates, normalisation is stable in both directions, bounds still hold,
and the correction-equality check does not report a spurious change when a legacy-shape
record is re-saved unchanged. Also cover the bounds on the medicine unavailability
list.

**Thin end-to-end.** One Playwright case: an admin on the clinical records screen
clicks each export button and a file arrives. Byte-level assertions live in seam 1,
where they sit closer to the code that produces them and run without a browser. The
accessibility suite is updated for the renamed controls.

**Regression note.** The existing foundations test asserting that the CSV encoder
neutralises formula prefixes must continue to pass for text cells. It must not be
weakened to accommodate numeric columns; numeric columns go through a different encoder.

## Out of Scope

* **An item-level export.** A narrow file with one row per Fulfilment item, aimed at a
  spectacle lab or an OT coordinator, was considered and deferred. The chosen grain is
  one row per Patient.
* **Cross-Camp and all-Camps exports.** Each file covers one Camp. Merging Camps with
  different Prescription templates into one sheet is not supported.
* **Date-range filtering** within a Camp.
* **An .xlsx writer.** Genuinely the better artifact — typed cells need no byte-order
  mark and no injection guard — but CSV was chosen. The flattening work is identical,
  so this remains available later without rework.
* **Export logging, reasons, or rate limits.** Declined.
* **Fully structured medicine line items with per-line outcomes.** Only the
  unavailable-medicine exceptions are itemised. Structured prescribing with inventory
  is a different product and would need its own ADR.
* **Snapshotting the Prescription template version onto each transcription.** Storing
  the diagnosis split directly fixes the drift without it.
* **Any change to the printed Prescription Sheet, Deferred fulfilment slips, the queue
  lifecycle, or Registration Staff surfaces.**
* **Backfilling or rewriting existing Prescription Transcription rows.**

## Further Notes

### Defects this change is expected to fix

1. Export contents depend on how many times the admin clicked "Load more".
2. The formula-injection guard rewrites every signed number as text; dormant only
   because powers currently sit inside JSON blobs.
3. The diagnosis option/Other split is recomputed against the live template, so
   template edits silently rewrite historical records.
4. The transcription validator checks a near-addition field the Clinical Desk never
   sends; the desk sends a differently named field. Dead branch — fix it or delete it,
   but do not leave a validation rule that can never run.
5. Exporting with no active Camp returns an empty file and no error.

### Documentation to update in the same change

* `CONTEXT.md`: add **Camp Records Export** and **Clinical Audit Export** to the
  ubiquitous language; amend **Prescription Transcription** to state that the diagnosis
  option/Other split is stored rather than derived and that medicines are free text
  plus an itemised unavailable list; amend **Clinical history** so that its vague
  "admins may review and export" points at the two named exports and their data
  boundary. `CONTEXT.md` is a glossary — no implementation detail belongs in it.
* Two ADRs: one recording the export design and its personal-data boundary (why two
  files, why household phone and address are included, why Aadhaar last-4 and date of
  birth are permanently excluded, why every seen Patient appears, and why exports are
  deliberately unlogged); one recording that diagnoses are stored as options plus
  Other, chosen over template-version snapshotting, with the no-backfill decision and
  its reasoning.

### Execution guidance

* **Work on a separate branch off `main`.** Do not commit to `main`, and do not merge.
  The branch will be reviewed and merged by a human.
* Read `AGENTS.md`, `CONTEXT.md`, and the ADRs in `docs/adr/` before starting. Where
  documentation conflicts, ADRs win, then `CONTEXT.md`, then `README.md`.
* Use the project's context tooling for exploration and edits rather than reading whole
  files, and prefer the smallest change that actually works — no new dependencies, no
  abstraction layers, no speculative configuration. If a decision in this spec can be
  implemented in one function, implement it in one function.
* Database changes must be **append-only incremental migrations**. Never reset,
  re-apply a baseline, or run destructive SQL against a live database. Production is
  never assumed to be empty.
* Verify empirically. A green suite is not evidence: every defect in this repo's July
  2026 audit passed the full suite. For each of the five defects above, demonstrate the
  new assertion failing against the pre-fix code, then passing.
* Run the full verification gate before reporting done, and report honestly — if a
  suite was skipped or a test fails, say so with the output. Do not report completion
  with any database test skipped.
* Anything this spec leaves genuinely ambiguous should be raised rather than decided
  silently. Do not widen the scope: the excluded personal-data fields, the declined
  export logging, and the one-row-per-Patient grain are settled decisions, not
  starting points.
