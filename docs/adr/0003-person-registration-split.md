# Person is permanent and global; Registration is per camp

---
Status: accepted
---

A patient's Aadhaar identity is unique across every camp, forever — but a patient's
queue state, prescription and treatment orders belong to one camp visit. Today a single
`patients` row conflates both: it carries `camp_id NOT NULL` alongside `queue_status`,
`camp_day_id`, `queued_at`, `seen_at` and `printed_at`, and both `prescriptions` and
`treatment_orders` foreign-key to it.

We split the two. A **Person** is the permanent, globally unique human, keyed on the
Aadhaar HMAC and owning the permanent registration number. A **Registration** is one
person's participation in one camp, owning queue state, camp day, prescription and
treatment orders. A returning patient keeps their registration number and receives a
fresh Registration.

## Considered options

- **One row per Aadhaar, overwritten each camp.** Rejected: each new camp would destroy
  the previous visit's queue and seen history, and
  `treatment_orders_pending_patient_kind_idx` (`UNIQUE (patient_id, kind) WHERE status =
  'pending'`) would prevent a returning patient from ever receiving the same treatment
  kind twice.
- **Keep per-camp rows, add a soft cross-camp link.** Rejected: cheaper and lower risk,
  but a returning patient would receive a new registration number, which defeats the
  point of global identity.

## Consequences

- `reg_no` is already `UNIQUE` across all rows from a single global sequence, so the
  permanent number needs no new sequence — it migrates onto Person.
- `treatment_orders_pending_patient_kind_idx` must be re-keyed from person to
  Registration, or a pending order from a prior camp will block the current one.
- Every RPC, KPI query and policy that says `patient_id` must be audited to decide
  whether it means the permanent Person or this camp's Registration. This is the largest
  migration in this batch and the highest-risk one.
- `age` cannot live on Person — it goes stale. See ADR 0004.
