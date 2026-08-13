# No FCFS Queue: presence is printed_at, lifecycle is registered → seen

---
Status: accepted
---

ADR 0008 bound Print prescription to putting the patient in a first-come line
(`registered → waiting`, ordered by `queued_at`). That produced three writers
of `waiting`, a Live Queue panel, and a public position number — more line
machinery than the desk uses.

**There is no FCFS Queue.** Lifecycle is exactly `registered → seen`. Print
prescription prints the paper and records presence (`printed_at`) once,
idempotently. It does not change status. Mark seen still refuses a never-printed
Registration. Undo (ten minutes, no Prescription Transcription) restores
`registered` and keeps `printed_at`. The passwordless status page shows camp
day, venue, and `registered` or `seen` — no position, no “in the hall” label.
The Volunteer Desk has no Live Queue panel. Seat caps still count every
Registration on the Camp Day.

`waiting` remains on the Postgres enum only because enum values cannot be
dropped; the app treats it as dead, same as `doctor` on `user_role`.

ADR 0008 still governs: paper is the prescribing record; the desk has exactly
two actions; queueing (now presence) is bound to the action, not to print-dialog
success. ADR 0007’s “no fourth state” stands; this ADR removes the third.
