# Registration and printing are separate actions; what prints is a camp setting

---
Status: accepted
---

The desk had exactly one action, `runDeskRegisterAndPrint`, which fused saving a patient
with opening a print window — so there was no way to pre-register someone without
printing, and the only path to a saved-but-unprinted patient was the popup-blocked
recovery UI. We split it into **Register** and **Register & print**, both always
available on every day, with print-later reachable from the patient list.

Separately, an admin may set a Camp's **registration print mode** to either **Desk Slip**
(default) or **Prescription Sheet** — a pre-filled form with ruled space for a doctor to
write on by hand, for camps whose doctor does not use the app. This gives the previously
dead `paper_fallback_mode` setting a real job.

## Considered options

- **A date-driven button set** — Register before camp day, Register & print on camp day.
  Rejected: it is a hidden mode. A volunteer pre-registering someone for a future day
  *on* camp day would get the wrong button, and reprinting a lost slip from the form
  would become impossible.

## Consequences

- Check-in semantics are unchanged and remain purely date-driven. Neither button decides
  who becomes `waiting` — the camp day does. `CONTEXT.md`'s "no desk mode toggle" rule
  survives intact.
- Printing a still-`registered` patient continues to check them in, in both print modes.
  The Prescription Sheet carries the Patient QR for exactly this reason.
- In Prescription Sheet camps the doctor never touches the app, so `queue_status` never
  reaches `seen` and no treatment orders are created by the doctor. See ADR 0007.
