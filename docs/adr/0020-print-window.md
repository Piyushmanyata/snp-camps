# Printing opens on a per-day admin switch behind a date floor

---
Status: accepted
---

The Volunteer Desk showed Print prescription as soon as a volunteer logged in,
including weeks before camp. Pre-registrations got printed by mistake, then the
button looked pointless. A date-only rule would still open printing at midnight
on camp morning, before the printer and the doctor are there. A camp-level
switch would open every day of a three-day camp at once, and yesterday's
setting would leak into today.

**Printing is open only when both are true:** the Camp Day's date is today in
`Asia/Kolkata`, and an admin has opened printing for that day. Every new Camp
Day starts closed. The switch is per day, not per camp. Team leads are gated
the same way as volunteers. Mark seen sits behind the same window, because
presence cannot exist while printing is closed.

The database is the refusal. `mark_patient_printed` rejects a write outside the
window with a distinct named error. The print URL server-renders a refusal
card. The desk hides Print and Mark seen while the window is closed and picks
up the open state on the existing poll — no new loop, no WebSocket.

Rejected: deriving the window from the camp-day date alone. Midnight is not
camp morning. Rejected: a camp-level switch with no date floor. It cannot
close one day of a multi-day camp, and a leftover flag would open printing on
the wrong calendar day.
