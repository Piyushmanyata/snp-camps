# Paper is the clinical record; printing it queues the patient

---
Status: accepted — queueing superseded by ADR 0013
---

The app had grown a second, parallel clinical system alongside the paper the camp
actually runs on: a Doctor Station that typed prescriptions into `prescriptions`,
a `treatment_orders` table, three counter stations that fulfilled or deferred those
orders, theatre capacity accounting, and an amendment log. None of it was used at a
camp. The doctor writes on paper, the volunteers move people through a line, and the
paper goes home with the patient.

Maintaining the digital twin cost more than it returned: it doubled the number of
states a volunteer could get a patient into, it produced the `/counter` dead-end for
doctors, and it was the source of most of the app's screens while being the part
nobody used.

## Decision

**The printed prescription is the clinical record. The app tracks a line, and
nothing else.**

Three consequences:

1. **The doctor holds no login role.** There is no Doctor Station and no doctor
   selection. `is_camp_crew()` and `is_staff()` describe the same set — admin, team
   lead, volunteer. The `doctor` value remains in the `user_role` enum only because
   Postgres cannot drop an enum value; residual doctor profiles are disabled.

2. **Printing is what puts a patient in the queue.** There is no separate check-in
   action at the desk. A volunteer scans, prints the prescription, and the patient
   is `waiting`. Queueing is bound to the *action*, not to print success — a jammed
   printer means the patient reprints, never that they lose their place. Reprinting
   is idempotent: it preserves the original `queued_at`, so it can never reorder
   the line.

3. **The desk has exactly two actions.** Print prescription, and Mark seen. Mark
   seen records `seen_at` and the volunteer in `seen_by`. It is idempotent — a
   double scan returns the original timestamp rather than re-stamping it — and it
   refuses a patient who was never queued, naming the reason. A mis-scan is
   reversible for ten minutes via `undo_mark_seen`, which restores the patient's
   original queue position.

The patient lifecycle stays exactly `registered → waiting → seen` (see
[ADR 0007](0007-awaiting-treatment-is-derived.md) — that constraint outlived the
feature it was written for).

## Consequences

**Dropped irreversibly:** `prescriptions`, `prescription_amendments`,
`treatment_orders`, `camp_days.theatre_capacity`, and the RPCs that served them.
This was safe only because production held test data and no real camp had run —
a one-time, explicitly authorised exception to the "production is never assumed
empty" rule in `AGENTS.md`, which otherwise still governs. Once a real camp has
run, that rule reapplies in full and future removals must archive rather than drop.

**Per-camp prescription template.** `camps.prescription_template` (jsonb) holds
header, footer, section-label and logo overrides; null means the built-in default.

**The letterhead is an image, not typeset text.** The organisation's header carries
Devanagari and Bengali script. Rendered as web text it would silently fall back to a
default font on any printing machine lacking those fonts — a failure you would only
discover on camp day, on the one day it matters. As an image it prints identically
everywhere, and it doubles as the admin-replaceable asset the template editor needs.

**The 58mm deferred slip is typeset Devanagari using a bundled subset font
scoped to the slip route.** The failure this ADR guards against is the *machine*
lacking the script. Bundling the font removes that dependency for the thermal
slip without changing the A4 letterhead decision above.

**What survived deliberately:** self-registration and Aadhaar card scanning (the
duplicate-prevention backbone), Person/Registration split
([ADR 0003](0003-person-registration-split.md)), and team leads and KPI rollups
([ADR 0005](0005-team-lead-role-and-kpi-rollup.md)).
