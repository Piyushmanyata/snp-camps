# Clinical Desk: the database refuses; one diagnoses reader

---
Status: accepted
---

The Clinical Desk had a second copy of save/correct/resolve rules in the
browser. That copy disagreed with Postgres on diagnoses and swallowed the real
refusal behind “try again.”

**The database is the no.** The form may highlight empty boxes. Save, correct,
and resolve show the database’s reason in Hinglish. Do not keep a parallel
TypeScript replica of `assert_valid_clinical_data`.

Desk, history, and Camp Records Export read the stored diagnoses split
(`options` + `Other`, including retired labels). They do not re-split against
the live template (ADR 0011). A no-op correction is a screen hint, not a
JSON-equality check in SQL.

Authorization and lock-on-first-fulfilment stay in the database (ADR 0009).
