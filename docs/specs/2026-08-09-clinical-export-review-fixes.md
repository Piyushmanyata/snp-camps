# Clinical export review fixes (follow-up to #128)

> Every decision in this document is already made. The executor implements; it does
> not adjudicate. Where two readings were possible, the chosen one is stated with
> "Decision:". If something genuinely cannot be implemented as written, stop and
> report — do not substitute your own design.

## Problem Statement

The Camp Records Export and Clinical Audit Export shipped on
`feature/issue-128-clinical-export-recording` and a two-axis code review found
defects that make the two files untrustworthy in exactly the ways issue #128
exists to prevent. From the people who use the system:

- **An admin loses a diagnosis the moment it leaves the template.** When an admin
  edits a Camp's Prescription template and removes a diagnosis option, every
  Prescription Transcription that recorded that option loses it. It has no column
  in the Camp Records Export, it is not in the `diagnosis_other` column, and its
  checkbox does not render at the Clinical Desk when the record is reopened. The
  fact was recorded, and it silently disappears — the exact failure the recording
  fix was supposed to end.

- **An admin cannot reconstruct what happened to a Deferred fulfilment slip.** The
  Clinical Audit Export produces one row per slip rather than one row per event. A
  slip that was issued and later replaced appears as a single row reading
  `cancelled`, stamped with the time it was *issued* and attributed to the person
  who *issued* it. The issue event is gone, the cancellation time is wrong, the
  actor is wrong, and a replacement cannot be told from a cancellation.

- **An admin opens the Camp Records Export and every household phone has junk in
  front of it.** Each phone cell ships as an apostrophe followed by a tab
  character followed by the digits, because the phone encoder applies the
  spreadsheet formula guard on top of its own tab prefix. This is the leading-
  apostrophe corruption the export's CSV rules exist to eliminate.

- **A Clinical Desk Operator's untouched record is logged as a correction.** A
  Prescription Transcription saved in the legacy diagnoses shape and re-saved with
  no content change is recorded as a Prescription Correction, because the two
  shapes flatten to different values when the legacy record held more than one
  free-text diagnosis. The audit trail accumulates corrections that never happened.

- **An admin exports a Camp they did not choose.** When no Camp is active, the
  admin clinical records screen silently selects the first Camp alphabetically and
  both exports follow it. The admin believes they are looking at one Camp's
  records and downloads another's.

- **A Clinical Desk Operator is asked to itemise medicines they are not marking
  unavailable.** The unavailable-medicines input renders for every unresolved
  Medicine Fulfilment item, not only when the Operator is resolving it as
  `not_available`.

- **An admin who hits an export error is thrown out of the screen.** A failed
  download navigates the browser away from the records screen to a raw JSON error
  body, losing their place and their filters.

Separately, the Camp Records Export filename is dated in UTC while every timestamp
inside the file is Asia/Kolkata, so a file downloaded before 05:30 IST is dated the
previous day; the export ignores the "published template only" rule and falls back
to the Camp's inline template; and the migration's readiness-probe rewrite performs
three unguarded string replacements that become silent no-ops if the probe text
ever drifts.

## Solution

Fix the shipped feature so both files are trustworthy, without redesigning it.

**Retired diagnosis options keep their column.** The Camp Records Export emits a
column for every diagnosis option in the Camp's published Prescription template,
and then a further column for every option that Prescription Transcriptions in
that Camp actually recorded but the template no longer offers, marked as retired.
The Clinical Desk shows the same retired options as checked, read-only rows when a
record is reopened, so re-saving cannot silently drop them.

**The Clinical Audit Export becomes one row per event, as promised.** A Deferred
fulfilment slip row contributes exactly one event — its issue — stamped with the
time it was issued and the person who issued it. Every later transition a slip can
undergo is already recorded elsewhere with a correct actor, timestamp and reason:
replacement as a Prescription Correction of kind `slip`, later fulfilment and
reversal as Fulfilment events. A replaced slip therefore reads as three honest
rows — issued, replaced with a reason, issued again — instead of one wrong one.

**Household phone is emitted exactly as recorded.** A valid phone is a quoted text
cell containing digits and nothing else.

**Shape-only re-saves stop counting as corrections.** Diagnosis equality compares
the same way regardless of which shape a record was saved in.

**The admin chooses a Camp deliberately.** With no active Camp, the selector opens
empty and both downloads are unavailable until a Camp is chosen. Export failures
appear in the existing error box; the admin stays on the screen.

## User Stories

1. As an admin, I want a diagnosis option that was later removed from the
   Prescription template to still have its own column in the Camp Records Export,
   so that I can count how many patients had it.
2. As an admin, I want retired diagnosis columns labelled as retired, so that I can
   tell a currently-offered diagnosis from one the template no longer has.
3. As an admin, I want retired diagnosis columns to appear after the template's own
   columns in a stable order, so that two exports of the same Camp have the same
   column layout.
4. As an admin, I want a diagnosis option recorded before it was retired to stay out
   of the `diagnosis_other` column, so that free text and checked options are not
   conflated.
5. As a Clinical Desk Operator, I want a retired diagnosis option on a record I
   reopen to render as a checked, read-only row, so that I can see what was
   recorded.
6. As a Clinical Desk Operator, I want re-saving a record that carries a retired
   diagnosis option to preserve that option, so that reopening a record cannot
   silently delete a clinical fact.
7. As an admin, I want the Camp Records Export to use only the Camp's published
   Prescription template for its diagnosis columns, so that an unpublished draft or
   a stale inline template cannot change the column set.
8. As an admin, I want a Camp with no published template to still export, with its
   recorded diagnoses appearing as retired columns, so that an unpublished template
   never costs me clinical data.
9. As an admin, I want one Clinical Audit Export row for each Deferred fulfilment
   slip that was issued, so that every issue is visible.
10. As an admin, I want a slip issue row stamped with the moment the slip was
    issued, so that the timeline is truthful.
11. As an admin, I want a slip issue row attributed to the person who issued it, so
    that I know who to ask.
12. As an admin, I want a slip that was replaced to show its replacement as its own
    row with the replacement reason, so that I can see why the slip changed.
13. As an admin, I want a replaced slip's successor to appear as its own issue row,
    so that a replacement reads as two events, not one status.
14. As an admin, I want to tell a replacement apart from a cancellation, so that I
    do not treat a re-issued slip as a withdrawn one.
15. As an admin, I want the slip reference and version in their own column, so that
    the "why" column holds a reason and only a reason.
16. As an admin, I want the Clinical Audit Export to keep showing Prescription
    Corrections, Fulfilment item resolutions and reversals unchanged, so that this
    fix costs me no existing coverage.
17. As an admin, I want household phone numbers to open as the digits that were
    recorded, with no apostrophe and no tab character, so that I can dial, sort and
    match them.
18. As an admin, I want a phone value that is not plain digits to still be guarded
    against spreadsheet formula injection, so that safety is not traded for
    tidiness.
19. As an admin, I want every operator-entered text column to keep its formula
    guard, so that this fix does not weaken the export's safety rules.
20. As a Clinical Desk Operator, I want a record saved in the legacy diagnoses shape
    and re-saved unchanged to not be recorded as a Prescription Correction, so that
    the correction history means something.
21. As a Clinical Desk Operator, I want that to hold when the legacy record held
    several free-text diagnoses, so that the common case is covered and not just the
    single-item one.
22. As an admin, I want the Camp selector to open empty when no Camp is active, so
    that I am never shown one Camp's records while believing they are another's.
23. As an admin, I want both download buttons unavailable until I have chosen a
    Camp, so that I cannot export a Camp I did not pick.
24. As an admin, I want the records screen to tell me to choose a Camp rather than
    show an error when none is active, so that an empty state does not read as a
    fault.
25. As an admin, I want a failed export to show its message in the screen's error
    box, so that I keep my place and my filters.
26. As an admin, I want a successful export to download as a file without navigating
    away, so that I can export both files in one visit.
27. As a Clinical Desk Operator, I want the unavailable-medicines input to appear
    only when I am resolving the Medicine Fulfilment item as `not_available`, so
    that I am not asked to itemise a fulfilment.
28. As a Clinical Desk Operator, I want the unavailable-medicines input cleared when
    I look up a different patient, so that one patient's medicine list can never be
    saved onto another's record.
29. As an admin, I want the export filename dated in Asia/Kolkata, so that a file
    downloaded early in the morning is not dated yesterday.
30. As an admin, I want a non-admin to receive no CSV bytes on any path, so that the
    export cannot leak.
31. As an admin, I want a test that fails if Aadhaar last-4, date of birth or email
    ever appears as a column in either export, so that the personal-data boundary is
    enforced by the suite and not by memory.
32. As an admin, I want an unauthenticated request to the export to be rejected and
    that rejection to be covered by a test, so that both the signed-out and the
    wrong-role paths are proven.
33. As an operator of this system, I want the migration's readiness-probe rewrite to
    fail loudly if any of its anchors no longer match, so that a silent no-op cannot
    leave the readiness catalog out of step with the schema.
34. As a developer, I want one shared diagnosis normalisation path rather than two
    copies, so that the Clinical Desk and the exports cannot drift apart.

## Implementation Decisions

### 1. Retired diagnosis options

The export RPC currently derives its diagnosis option list from the Camp's
published Prescription template version, falling back to the Camp's inline
`prescription_template` when no published version exists.

- **Decision:** delete the inline-template fallback. Published template versions are
  the only source, per the accepted spec. A Camp with no published version yields
  an empty template option list.
- **Decision:** the RPC additionally computes the set of diagnosis options actually
  stored on that Camp's Prescription Transcriptions (after applying the latest
  clinical Prescription Correction, i.e. the same record body the export reads),
  reading the `options` array of the stored `{ options, other }` shape only. Legacy
  array-shaped records are **not** scanned for this purpose — a legacy record has no
  asserted option/other split, and its unmatched entries already fall through to
  `diagnosis_other`. This preserves ADR 0011's no-backfill rule.
- **Decision:** the returned option list is the published-template options in
  template order, followed by the stored-but-not-in-template options sorted
  ascending by `btrim` value. Comparison and de-duplication are on the `btrim`-ed
  string, case-sensitive.
- **Decision:** the RPC returns the two groups distinguishably so the CSV builder can
  label them. Return the existing `diagnosis_options` array unchanged in meaning
  (now the full ordered list) plus a parallel `retired_diagnosis_options` array
  holding just the retired subset. The CSV builder emits header
  `diagnosis: <option>` for template options and `diagnosis: <option> (retired)`
  for retired ones. Cell values are unchanged: `yes` or blank.
- **Decision:** an option that is retired is matched against the stored `options`
  array only — it must not be matched against `other` free text.

At the Clinical Desk, the diagnosis fieldset renders one checkbox per published
template option.

- **Decision:** when a loaded record's stored `options` array contains a value not in
  the current template, render it after the template checkboxes as a checked,
  `disabled` checkbox labelled `<option> (retired)`.
- **Decision:** these retired values stay in the component's selected-diagnoses state
  and are written back in the saved `options` array on the next save. The Operator
  cannot check them and cannot uncheck them.
- **Decision:** retired values do not participate in the Other-text derivation.

### 2. Deferred fulfilment slip audit grain

Established behaviour of the underlying functions, verified against the schema and
the workflow migrations — the executor should not re-derive this:

- A slip row is inserted once, at issue, carrying a correct `issued_at` and
  `issued_by`.
- Replacement cancels the old slip, inserts a successor slip row (whose `issued_at`
  and `issued_by` are the replacement moment and actor), sets `replaced_by` on the
  old row, **and** writes a Prescription Correction of kind `slip` carrying the
  mandatory replacement reason.
- `status = 'cancelled'` is only ever reached through replacement.
- Later fulfilment writes a Fulfilment event `fulfilled_later`; reversal writes a
  Fulfilment event `reversed` plus a Prescription Correction of kind `fulfilment`.
- Slip status transitions after issue therefore carry no timestamp and no actor on
  the slip row itself, and every one of them is already emitted by the Prescription
  Correction arm or the Fulfilment event arm of the audit query.

Given that:

- **Decision:** the slip arm of the audit query emits the literal event `issued`, not
  the slip's current `status`. One row per slip row, timestamped `issued_at`,
  attributed to `issued_by`.
- **Decision:** no synthetic cancellation, replacement or fulfilment rows are
  generated from the slip table. The other two arms already carry them.
- **Decision:** no schema change. Do not add transition timestamps to the slip table.
- **Decision:** the audit output gains a `slip_reference` field, populated for slip
  rows as the slip reference and version (reference, a space, `v`, the version
  number) and empty for every other entity. The `reason` field for slip rows becomes
  empty — the reason for a replacement lives on the Prescription Correction row.
- **Decision:** `to_outcome` for slip rows stays the slip's service. `from_outcome`
  stays empty.
- **Decision:** the Clinical Audit Export gains one column, `slip_reference`, placed
  immediately after `to_outcome` and before `reason`. Existing column names and
  order are otherwise unchanged.
- **Decision:** ordering of the audit rows is unchanged (timestamp, then registration
  number).

### 3. Household phone encoding

The phone encoder currently prefixes a tab and then routes through the text
encoder, whose formula-guard character class includes tab — so the guard fires on
the encoder's own prefix.

- **Decision:** a value that is entirely digits after trimming, of length 4 to 15
  inclusive, is emitted as a quoted cell containing exactly those digits — no tab,
  no apostrophe.
- **Decision:** any other non-empty value falls through to the ordinary text encoder,
  formula guard included.
- **Decision:** null, undefined and empty-after-trim emit an empty quoted cell, as
  today.
- **Decision:** the formula-guard character class is not modified. Other columns keep
  the guard exactly as it is.

### 4. Diagnosis equality across shapes

The flattening helper normalises without the template option list, so a legacy
array flattens to its items while the equivalent new shape flattens to a single
joined `other` string.

- **Decision:** when flattening, split the `other` value on semicolons, trim each
  part and drop empties, so that a joined legacy free-text list and the individual
  entries compare equal. The result stays a sorted multiset of strings.
- **Decision:** this splitting is for equality only. It does not change what is
  stored, and it does not change the `diagnosis_other` column, which continues to
  emit the stored `other` string verbatim.
- **Decision:** accept that a single genuine free-text diagnosis containing a
  semicolon splits for comparison purposes. It splits identically on both sides, so
  equality stays correct; this is a deliberate trade and must not be "fixed" by
  adding an escape scheme.
- **Decision:** the transcription-validation module deletes its local copy of the
  flattening helper and imports the shared one. There must be exactly one flattening
  implementation in the codebase.
- **Decision:** delete the unused equality helper export from the diagnoses module if
  it still has no callers after this change.

### 5. Camp selection and export failure

- **Decision:** the admin clinical page no longer falls back to the first Camp. The
  preselected Camp is the active Camp, or nothing.
- **Decision:** with no active Camp, the page does not call the records RPC. It
  renders with an empty record list and no error, and the screen shows a
  choose-a-Camp empty state rather than an error box.
- **Decision:** both download buttons are `disabled` while no Camp is selected. The
  existing runtime guard in the download handler stays as a second line of defence.
- **Decision:** the download handler fetches the export URL rather than navigating.
  On success it turns the response into a blob and triggers an anchor download using
  the filename from the response's `Content-Disposition`. On failure it reads the
  error message from the JSON body and sets it on the existing export-error state.
  The admin is never navigated away from the screen.
- **Decision:** the raw `<select>` is replaced with the shared `Select` component
  from the UI module, keeping its accessible name exactly as it is today so the
  existing accessibility spec keeps passing.

### 6. Clinical Desk state and gating

- **Decision:** the per-patient state reset clears the unavailable-medicines input
  along with every other per-patient field.
- **Decision:** the unavailable-medicines input renders only when the Operator is
  resolving the Medicine Fulfilment item as `not_available` — not for every
  unresolved Medicine item. The existing 1-to-12 entries and 1-to-120 characters
  validation bounds are unchanged.

### 7. Filename and migration hygiene

- **Decision:** the export filename's date component is the Asia/Kolkata calendar
  date, derived through the same IST formatting path the cells use, not
  `toISOString`.
- **Decision:** each of the three currently unguarded string replacements in the
  migration's readiness-probe rewrite gets an anchor assertion that raises if the
  expected text is absent, matching the guard already present on the migration-head
  replacement and the precedent set by the earlier clinical-desk migration.
- **Decision:** the readiness expectation flip for the patients authenticated-select
  privilege stays as it is. It is correct against the actual grants, reverting it
  would break the probe, and it is called out here only so it is described in the
  pull request rather than discovered later.
- **Decision:** the changes above that touch the export RPC and the audit output ship
  as a **new** migration with a later timestamp. The already-committed migration is
  not edited — migrations are append-only. The new migration replaces the export
  function, re-applies its grants, and advances the readiness catalog head to the
  new timestamp using the same guarded-replacement pattern.

### 8. Explicitly not changing

Confirmed correct by review; do not touch, refactor or "improve":

- The route's session-then-role admin gate and its ordering ahead of any service-role
  client construction.
- The personal-data boundary: the included column set, and the audit export carrying
  registration number and actor name only.
- The left join that includes patients who reached `seen` without a Prescription
  Transcription.
- The latest-clinical-correction-wins selection, the Camp scoping, and the archived
  filter.
- The explicit error when no Camp is selected and none is active.
- The absence of any row limit on the export path.
- The byte-order mark, CRLF line endings, Asia/Kolkata cell timestamps and bare
  numeric cells.
- The `{ options, other }` storage shape, legacy array readability, and the absence
  of any backfill.
- Unavailable medicines being stored on the Fulfilment item and in the Fulfilment
  event.

## Testing Decisions

A good test here asserts what a caller can observe — the bytes of the CSV, the
status and headers of the response, the rows the RPC returns — and never reaches
into how those were produced. No test may assert on an internal helper's
intermediate value where the same fact is observable at the seam above it.

**Seams.** All four already exist; no new seam is introduced.

1. **The export RPC**, exercised against a real Postgres via the existing clinical
   export database test. Highest seam for anything expressed in SQL.
2. **The export route**, exercised through the existing route-loader harness. Highest
   seam for authorization, headers, filename and whole-document bytes.
3. **The CSV encoding and diagnoses modules**, exercised as pure functions. Used only
   for cases that cannot be provoked through a higher seam.
4. **The accessibility spec**, for the accessible names of the two download buttons
   and the Camp selector.

**Required coverage.**

At the database seam (prior art: the existing clinical export database test, which
correctly hard-fails when the database or an RPC is missing — preserve that; a test
that reports an unavailable database as a skip is not acceptable):

- A Camp whose published template dropped an option that a transcription recorded:
  the returned option list contains it in the retired group and the row marks it.
- A Camp with no published template version: the export succeeds and recorded
  options appear as retired.
- A slip issued, then replaced: the audit rows contain an issue event for each slip
  at each slip's own issue time and actor, plus the `slip` Prescription Correction
  carrying the replacement reason. No row reports `cancelled` at the original issue
  time.
- A slip issued then fulfilled later, then reversed: issue event once, plus the
  existing Fulfilment event rows.

At the route seam (prior art: the existing clinical export route test):

- Unauthenticated request is rejected and returns no CSV bytes.
- Authenticated non-admin is rejected and returns no CSV bytes.
- The header row of **both** exports contains no field matching Aadhaar, date of
  birth or email, asserted case-insensitively against the header line so that adding
  such a column in future fails the suite.
- A household phone cell equals the quoted digits exactly — no apostrophe, no tab.
- The filename's date component is the Asia/Kolkata date. Assert it by generating the
  filename at a fixed instant that falls in the 00:00–05:30 IST window, where UTC and
  IST disagree on the date.
- Retired diagnosis columns appear after template columns with the retired label.
- The audit export carries the `slip_reference` column in its stated position.

At the unit seam:

- Legacy array with two free-text diagnoses versus the equivalent new shape with a
  semicolon-joined Other: equal, therefore no Prescription Correction.
- Legacy array versus a genuinely changed new shape: not equal.
- The phone encoder: plain digits, digits with surrounding whitespace, empty, and a
  hostile non-digit value that must still be guarded.

**Do not** add a test that asserts the retired-option scan reads the stored shape
only — that is an implementation detail; assert instead that a legacy-shaped record
produces no retired columns, which is the observable consequence.

## Out of Scope

- The thin Playwright click-the-download end-to-end case. It remains unimplemented
  and is not required by this spec; route-level and accessible-name coverage stand.
- Any schema change to the Deferred fulfilment slip table, including per-transition
  timestamps or an actor column.
- Backfilling legacy array-shaped diagnoses into the `{ options, other }` shape. ADR
  0011 forbids it.
- Export logging, spreadsheet-format output, and multi-Camp export. All declined in
  the accepted spec.
- Reverting or re-litigating the readiness expectation flip for the patients
  authenticated-select privilege.
- Fixing unrelated database-suite failures that this branch did not cause.
- Opening, merging or pushing a pull request. A human does that.
- Drive-by refactors. The remaining review nits — an unused function parameter on the
  audit builder, an unused parameter on a test helper, and the spectacle-field
  accessor re-walking the record body — are acknowledged and deliberately left alone.

## Further Notes

The branch is `feature/issue-128-clinical-export-recording`, tipped at the single
commit that implemented #128, and is local only. The evidence recorded at implement
time — type-check clean, 414 unit tests passing, the export database tests passing
after a clean reset — was **not** re-verified during review, and the full database
suite was already known to be short of green because of a readiness-probe residual.
Re-run the type check, the unit suite, and the export database tests after a clean
reset, and report the raw outcomes. Do not claim a suite is green on the strength of
this document.

Two review findings converged from both the standards and the spec axis
independently: the phone double-encoding, and the readiness expectation flip riding
along in a commit scoped to exports. Both are addressed above.
