# OT is scheduled across dated, seat-limited days

---
Status: accepted
---

OT had one admin-configured surgery date and no seat count. A surgeon operates
on a fixed number of eyes per day. One date cannot spread a camp across
several operating days, nothing stopped that date being over-committed, and
the slip could not tell the patient which day was actually theirs.
Auto-creating a date when the last one filled would invent an operating day
the surgeon has not agreed to. Letting a deferral past the seat count would
make the limit decorative.

**Admins configure OT schedule days: date, venue, seat limit.** Unique per
camp plus date. Seats taken is the count of still-deferred OT Fulfilment items
assigned to that day, never a stored counter. A deferral takes the earliest
day with a free seat; the operator may move the patient to any other day that
still has seats. Full days are not selectable. When every day is full the
deferral is refused by name and the other three Clinical lines continue.
Spectacles collection keeps its single admin date and venue.

The assigned schedule day is what the thermal slip prints and what the
deferral SMS carries, at issue and again the day before. An issued slip keeps
its snapshot; later schedule edits affect only future deferrals. A seat limit
below the number already assigned is refused. If the chosen day fills before
the write lands, refuse — do not silently move the patient.

Rejected: a single OT date. It cannot express capacity or a multi-day list.
Rejected: overflow past the seat count. A limit that does not refuse is not a
limit. Rejected: auto-creating dates. An operating day is a surgeon's
commitment, not a counter overflow.
