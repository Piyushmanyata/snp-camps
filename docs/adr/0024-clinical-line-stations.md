# The clinical desk is four line stations

---
Status: accepted
---

The Clinical Desk showed one operator every clinical field and every
fulfilment decision at once: diagnoses, vitals, remarks, medicines, the
spectacle power table, OT eye and procedure, and three fulfilment kinds.
Four different people work four different lines. Each of them had to navigate
past the other three lines' fields. Splitting `specs` into two stored
fulfilment kinds would make "fixed-power" and "to-be-made" look like different
products in the database, when they are two outcomes of the same item.

**The Clinical Desk Operator picks one Clinical line on opening the desk** —
fixed-power spectacles, medicine, spectacles-to-be-made, or OT — and sees
only that line's fields and that line's decision. The choice persists locally,
survives reloads, carries across patients, and stays visible. Shared clinical
fields are editable only until a Prescription Transcription exists; after that
they are read-only on every station and change through the existing reasoned
correction. Admins may keep the single-screen review surface.

No schema change. No new fulfilment kind. No enum change. The two spectacles
lines resolve the same Fulfilment item; if one has already decided, the other
is refused by name.

Rejected: one screen showing all lines. That is the current desk, and it is
why the wrong person edits the wrong fields. Rejected: splitting `specs` into
two fulfilment kinds. The paper and the archive already treat them as one
item with two outcomes; a fourth kind would be a third desk action in
disguise.
