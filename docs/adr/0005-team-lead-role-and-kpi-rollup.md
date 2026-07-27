# Team Lead is a login role, and team KPIs are distinct-counted

---
Status: accepted
---

Volunteers need a supervisory tier that can create volunteers and see their team's
numbers. We add **`team_lead`** as a fourth value in the `user_role` enum rather than a
flag on `volunteer`, so `is_staff()` becomes admin + team_lead + volunteer and RLS
predicates stay readable. Teams are implicit — a volunteer carries a lead reference;
there is no `teams` table for a hierarchy that is exactly two levels deep.

A Team Lead's KPI is the count of **distinct** patients handled by the lead or by any
volunteer currently linked to them — deliberately *not* the arithmetic sum of the
individual cards.

## Considered options

- **A boolean flag on `volunteer`** instead of a new role. Rejected: `volunteer` would
  mean two different things depending on a flag, which is how RLS bugs happen.
- **A generic recursive manager tree.** Rejected: recursive CTEs in every KPI and
  leaderboard query to model a hierarchy that is two levels deep.
- **Plain arithmetic sum for the rollup**, which is what was literally asked for.
  Rejected: `staff_person_kpis` counts *patients handled* as a union of `created_by` and
  `checked_in_by`. Summing volunteers therefore double-counts every patient one
  teammate registered and another checked in, overstating real throughput and rewarding
  teams that pass patients around over teams that own them end to end.

## Consequences

- A Team Lead's headline number is normally **smaller** than the individual cards
  beneath it add up to. Every screen showing a rollup must label it "distinct patients"
  or volunteers will read the shortfall as their work being discounted.
- `staff_person_kpis` currently raises `forbidden` when a non-admin reads another
  person's numbers. Leaderboards are cross-person by definition, so that guard must be
  widened to allow all camp crew to read **aggregate counts only** — never patient PII.
- Team Leads creating volunteers means a non-admin reaches the service-role
  `auth.admin.createUser` path. That route must enforce server-side that a lead can mint
  `volunteer` and nothing else, onto their own team and no other.
- KPI attribution follows a volunteer's *current* lead, so reassigning a volunteer
  mid-camp retroactively moves their history and visibly drops the old lead's number.
  Accepted in exchange for a single live join and no membership-history table.
