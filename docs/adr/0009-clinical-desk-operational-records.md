# ADR 0009: Clinical Desk operational records and deferred fulfilment

## Status

Accepted

## Context

ADR 0008 simplified the live doctor desk to two actions and removed the unused doctor, counter, digital-prescription, and treatment-order workflows. That decision correctly established the paper prescription as the prescribing source and protected the live queue from unnecessary complexity.

The camp nevertheless needs a separate post-doctor station to record the minimum prescription fields needed for fulfilment, record whether medicine, fixed-power spectacles, and OT needs were fulfilled or deferred, print small deferred-care slips, and complete unresolved items at a later camp or follow-up desk. Registration volunteers and team leads must not perform this work.

## Decision

Introduce a least-privilege `clinical_operator` role, presented as **Clinical Desk Operator**.

The role:

- can open a patient only by scanning the Patient QR or entering an exact registration number;
- can work only with a registration that has reached `seen`;
- can transcribe the doctor's paper prescription into an operational record;
- can independently resolve Medicine, Specs, and OT items;
- can print a 58 mm Specs or OT slip only for a deferred matching item;
- can complete a previously unresolved item through a narrow exact-lookup follow-up flow;
- cannot register patients, manually enter Aadhaar identity details, print the original A4 prescription, mark a patient seen, manage staff, view leaderboards, browse patients, or export clinical data.

The paper prescription remains the prescribing source of truth. The database transcription is an operational record for fulfilment and continuity, not a substitute for a doctor's prescription.

The existing queue lifecycle remains `registered → waiting → seen`; clinical fulfilment is modeled separately and does not add another queue state.

Clinical records use immutable attribution and append-only correction and fulfilment history. Deferral slips are versioned snapshots. No clinical PHI is exposed on public status pages or stored for offline synchronization.

ADR 0008 remains controlling for the live registration/doctor desk and its two desk actions. This ADR supersedes only ADR 0008's prohibition on storing any clinical information and its assumption that the post-doctor journey is entirely outside the product.

## Consequences

- Authorization must be enforced in database-backed operations, not only in the UI.
- Clinical data becomes sensitive retained data and needs explicit RLS, audit, export, archive, and correction behavior.
- A Clinical Desk can operate independently of the live doctor queue after a patient is seen.
- Deferred Specs and OT work can be represented by separate 58 mm slips and completed later without rewriting history.
- Offline clinical entry is intentionally unsupported; paper is the outage fallback.
- The earlier doctor/counter/stock/capacity workflow is not restored.
