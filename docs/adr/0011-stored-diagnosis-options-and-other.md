# ADR 0011: Stored diagnosis options plus Other

## Status

Accepted

## Context

Prescription Transcriptions used a flat list of diagnosis strings. The Clinical
Desk split that list into template options versus free-text Other by comparing
against the **current** published Prescription template on every read. Editing
the template therefore rewrote historical records: removing an option turned
past checks into free text; adding an option turned past free text into a
checkbox.

Template-version snapshotting on each transcription was considered as an
alternative. It would freeze the option list but still require re-deriving the
split, and would couple every read to historical template versions.

## Decision

Store the split explicitly on every new save:

```
diagnoses: { options: string[]; other: string | null }
```

Legacy rows remain a flat `string[]`. There is **no destructive backfill**: a
backfill would have to guess the split using today's template and would
reintroduce the drift being fixed. A single shared normalisation function reads
either shape; legacy rows keep previous display behaviour when a template option
list is supplied; equality for Prescription Corrections compares a flattened
normalised form so re-saving an unchanged legacy record in the new shape does
not force a spurious correction.

Unavailable medicines are **not** stored on the transcription. They are
captured when the Medicine Fulfilment item is resolved as `not_available`, and
stored on that item (and its event). A fulfilment decision locks the
transcription; putting stock facts on the transcription would either force early
capture or a Prescription Correction for a routine dispensing fact.

## Consequences

- Template edits no longer rewrite historical option/Other classification for
  new-shape rows.
- Exports and the Clinical Desk share one normalisation path.
- SQL and TypeScript validators accept both shapes within existing bounds
  (1–12 diagnoses, 1–120 characters each).
- Operators itemise unavailable medicines only when resolving Medicine as not
  available.
