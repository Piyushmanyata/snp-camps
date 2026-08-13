# Team Lead is a login role, and KPIs are original-registrar only

---
Status: accepted
Supersedes: prior draft that mixed `created_by` ∪ `checked_in_by` “handled” credit
Amended: 2026-07-31 (issue-124 + adversarial deep review remediation)
---

Volunteers need a supervisory tier that can create volunteers and see their team's
numbers. We add **`team_lead`** as a fourth value in the `user_role` enum rather than a
flag on `volunteer`, so `is_staff()` becomes admin + team_lead + volunteer and RLS
predicates stay readable. Teams are implicit — a volunteer carries a lead reference;
there is no `teams` table for a hierarchy that is exactly two levels deep.

## Competitive KPI credit (amended)

A registration scores **once**, for its **immutable original registrar**
(`patients.created_by` only). Print / check-in / mark-seen do **not** move competitive
credit. Labels on the desk KPI strip are **Registered** and **Seen** (original-registrar
credit), never “handled / today / in queue” zeros.

A Team Lead’s personal strip when `p_role = team_lead` rolls up registrations whose
`created_by` is the lead **or** any volunteer currently linked to them — still
original-registrar only, and deliberately *not* the arithmetic sum of individual cards
when the same patient would otherwise be double-counted across actions.

## Considered options

- **A boolean flag on `volunteer`** instead of a new role. Rejected: `volunteer` would
  mean two different things depending on a flag, which is how RLS bugs happen.
- **A generic recursive manager tree.** Rejected: recursive CTEs in every KPI and
  leaderboard query to model a hierarchy that is two levels deep.
- **Union of `created_by` and `checked_in_by` as “handled”.** Rejected (issue-124): it
  rewards print/check-in traffic over ownership of the registration, and double-counts
  when one teammate registers and another checks in.
- **Plain arithmetic sum for the rollup.** Rejected: overstates real throughput when
  distinct-patient counting is what supervisors need.

## Consequences

- Desk KPI islands must pass `team_lead` when the signed-in profile is a team lead so
  `staff_person_kpis` rolls up the team on refresh as well as on SSR.
- Leaderboards remain cross-person aggregate counts only — never patient PII.
- Team Leads creating volunteers means a non-admin reaches the service-role
  `auth.admin.createUser` path. That route must enforce server-side that a lead can mint
  `volunteer` and nothing else, onto their own team and no other.
- KPI attribution for team rollups follows a volunteer's *current* lead, so reassigning a
  volunteer mid-camp moves future rollups and can change the old lead's number.
  Accepted in exchange for a single live join and no membership-history table.
