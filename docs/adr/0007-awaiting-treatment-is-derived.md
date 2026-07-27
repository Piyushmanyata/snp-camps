# Awaiting treatment is derived from pending orders, not a queue state

---
Status: accepted
---

Patients must be tracked after the doctor has seen them, split into OT, Medicines and
Spectacles queues. The `treatment_orders` table with its `kind` and `status` columns
already models this, and `isPatientCompletedDerived` already establishes the pattern of
computing completion from orders rather than storing it.

**Awaiting treatment** is therefore a *derived* view — `seen` with at least one `pending`
order — and `queue_status` keeps its three values (`registered → waiting → seen`) with
no fourth added. The existing `/counter` desk is the single surface for these queues; the
work is surfacing it, not rebuilding it.

## Consequences

- `/counter` and `/print/prescription/[id]` both already exist, are already gated to
  camp crew, and are **linked from nowhere in the codebase** — reachable only by typing
  the URL. Both must be wired into navigation. An Awaiting treatment card on the admin,
  Team Lead and volunteer dashboards shows the three live counts and deep-links into the
  matching station tab.
- The `registered → waiting → seen` invariant, and every KPI and seat-board count built
  on it, are untouched.
- In **Prescription Sheet** camps (ADR 0006) the doctor writes on paper, so no treatment
  orders exist. Counters therefore gain the ability to *create* orders: staff scan the
  patient's QR, tick what the handwritten sheet says, and fulfil in the same action.
  Paper camps get working queues without a separate transcription station — at the cost
  of capturing only which counters to visit, not the diagnosis text.
