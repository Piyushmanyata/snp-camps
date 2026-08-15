# The unit suite is DB-free and skip-free

---
Status: accepted
---

`scripts/run-db-tests.mjs` fails the run when any `tests/*.db.test.mjs` test
skips, because a skipped database test is a failure, not a pass.
`scripts/run-unit-tests.mjs` had no such guard, and the suffix — not the
content — decides which runner owns a file. Three suites named `*.test.mjs`
held database tests behind a `skipIfNoDb` helper. They reported
`skipped 10` and `fail 0`, and `npm test` exited 0.

Those ten tests had not run in any environment without a local Postgres, and
nothing said so. Worse, their `connectDb()` helpers probed
`to_regprocedure(...)` and returned "unavailable" when an RPC was missing —
the precise pattern AGENTS.md records as having hidden three real failures
before. A migration that dropped one of those RPCs would have turned the suite
greener, not redder.

**A test that needs Postgres lives in a `*.db.test.mjs` file.** The database
halves of `empirical-challenge`, `empirical-challenge-m2-1`, and all of
`empirical-challenge-m3-1` moved there; their reachability helpers now only
call `.connect()`, so a missing RPC fails loudly. `run-unit-tests.mjs` gained
the same zero-skip guard as the DB runner, which makes the misfiling
self-reporting rather than silent. The unit suite now runs 458 tests with 0
skipped.

`adversarial-challenger-m4.test.mjs` PROBE 2 already banned `to_regprocedure`
in DB-suite connect helpers, but matched only the exact name `connect`. All
three offenders spelled it `connectDb` and passed. The probe now matches any
`connect*` helper.

Rejected: adding the zero-skip guard to the unit runner and leaving the files
where they were. One small change instead of a file move, but it makes
`npm test` — the fast, dependency-free gate — require Docker to pass, which
inverts the reason the two suites are separate.
