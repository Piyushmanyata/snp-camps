# A partial print run still prints

---
Status: accepted
---

`handlePrint` in `src/components/print-actions.tsx` recorded presence for every
patient on the sheet, then threw if any one of them was refused. The throw
happened before `window.print()`, so a single refusal suppressed the paper for
everybody — including the patients whose `printed_at` had just been committed.

A two-patient sheet where the second patient's camp had just been deactivated
left the first patient recorded as present, eligible for **Mark seen**, and
holding nothing. Presence is written once and a reprint keeps the original
timestamp ([ADR 0008](0008-printing-queues-the-patient.md)), so there was no way
to re-derive the lost paper from a second arrival — the desk had to notice the
patient was standing there empty-handed.

**Paper is the clinical record, so paper wins.** `resolvePrintRun` in
`src/lib/print-run.ts` decides the run from the results: the dialog opens
whenever at least one patient's presence was recorded, and the refusal is shown
as an error toast instead of replacing the print. Only a run that recorded
nothing throws. An empty sheet still prints nothing.

Printing a sheet for a patient whose presence write was refused is the harmless
direction of this trade: that patient is exactly a pre-registered patient who has
paper and no `printed_at`, which is a state the desk already produces and can
correct with a reprint. Presence without paper is the direction that cannot be
corrected from the desk.

The decision lives in `src/lib/print-run.ts` rather than in the component
because the unit suite has no DOM, and the repo already splits component logic
this way — `clinical-record-format.ts` to `clinical-record-view.tsx`.

Rejected: recording presence only after `window.print()` returns. It removes the
window entirely, but the browser reports neither the dialog being dismissed nor
the printer failing, so presence would go unrecorded whenever the operator
cancelled — trading a rare visible failure for a common silent one.
