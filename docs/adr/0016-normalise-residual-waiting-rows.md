# Residual `waiting` rows are normalised to `registered` with their arrival kept as presence

---
Status: accepted
---

ADR 0013 removed the FCFS Queue. Production may already hold rows in the retired
`waiting` state, written by the pre-print registration path and by the three
former `waiting` writers. Postgres cannot drop an enum value, so `waiting` stays
on `queue_status` forever and those rows would keep reading as a line.

**The Phase 1 migration rewrites every `waiting` row once:**

```sql
UPDATE public.patients
SET queue_status = 'registered',
    printed_at = coalesce(printed_at, queued_at)
WHERE queue_status = 'waiting';
```

`queued_at` is left untouched as history. Nothing writes it afterwards.

The rewrite is **irreversible for `queue_status`**: after it runs there is no
record of which rows were `waiting`. It is safe to run against production
regardless of what is there, because it only moves rows out of a state the app no
longer understands, and because `printed_at` is preserved when already set — a
row that was already `waiting` had been printed for, so its `queued_at` is its
arrival. This is not a precedent for destructive migrations; it deletes no rows
and no columns.

## Consequences

Only two lifecycle values exist in data after Phase 1, so no read site needs a
`waiting` special case. `mark_seen` gates on `printed_at IS NULL` rather than on
a status value, which means a residual row that reaches production later — hand-
written, or restored from an old backup — is still markable seen on presence
alone, without a defensive branch.

A `waiting` row with `queued_at IS NULL` (never produced by any known writer)
would land as `registered` with no presence and would have to be reprinted
before it could be marked seen. That is the correct outcome: nothing recorded
that they arrived.

## Rejected alternatives

**Leave the rows and tolerate them.** Every read site would keep a `waiting`
branch — the desk badge, the status page, the KPI rollups, `mark_seen` — to
service a state the product says does not exist. ADR 0013's whole point is that
the line machinery costs more than the desk uses.

**Normalise `queue_status` only, leaving `printed_at` null.** Those patients had
been printed for; dropping that fact would make `mark_seen` refuse them with
"never printed" and force a volunteer to reprint paper the patient is already
holding. Presence is the one thing worth carrying across.
