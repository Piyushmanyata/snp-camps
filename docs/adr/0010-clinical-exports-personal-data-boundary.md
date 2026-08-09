# ADR 0010: Clinical exports and personal-data boundary

## Status

Accepted

## Context

Admins need a usable Camp-wide clinical extract. The previous client-side
"export loaded records" button only wrote whatever was on screen (often 50
rows), mixed identity with raw JSON, and omitted patients who were seen but
never transcribed. Export design must also decide what personal data is safe to
place in a downloadable spreadsheet, and whether downloads are logged.

## Decision

Provide two server-side CSV downloads, both admin-only:

1. **Camp Records Export** — one row per Patient who reached `seen` in one Camp,
   left-joined to the effective Prescription Transcription (latest clinical
   Prescription Correction wins). Clinical fields are flattened into columns.
   Untranscribed seen patients appear with blank clinical columns.

2. **Clinical Audit Export** — one row per append-only event (corrections,
   fulfilment events, deferred slip lifecycle). Identifies patients by
   registration number only; actor is a display name.

Personal-data boundary for Camp Records:

- **Included:** registration number, patient name, age, gender, household phone,
  address, camp name, clinical fields, fulfilment outcomes.
- **Permanently excluded:** Aadhaar last-4, date of birth, email. Aadhaar last-4
  with name, DOB and gender reconstructs the One-Person-per-Aadhaar key.

Household phone and address are included because they are operationally required
for follow-up and because phone identifies a household, not a unique patient.

Exports are deliberately **unlogged**. Logging was considered and declined by
the product owner; absence of export audit is intentional, not an oversight.

CSV is Excel-first: UTF-8 BOM, CRLF, Asia/Kolkata timestamps, numeric cells for
validated numbers, formula-injection protection on operator-authored text.

## Consequences

- Export content is independent of on-screen pagination.
- A guessed export URL without an admin session returns an error, not a file.
- Clinical Desk Operators gain no export controls.
- Future work can add an .xlsx writer without redoing the flattening model.
- If export logging is later required, it is a new decision that supersedes this
  ADR's explicit non-logging choice.
