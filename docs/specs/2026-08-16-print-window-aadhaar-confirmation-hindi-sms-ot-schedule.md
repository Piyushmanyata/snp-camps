# Spec: Print Window, Aadhaar Confirmation, Hindi SMS, Clinical Line Stations, OT Schedule

**Date:** 2026-08-16
**Status:** Accepted — ready for agent
**Supersedes rules in:** `CONTEXT.md`, `AGENTS.md`, ADR 0008

---

## HOW TO USE THIS SPEC (read this section first, completely)

You are implementing this spec. Follow these rules exactly. They are not suggestions.

### Rule 1 — Work in the phase order given

Section **Implementation Decisions** is divided into **Phase 0 through Phase 11**. Do them
in numeric order. Each phase lists what it depends on. Do not start a later phase before
its dependencies are complete, because later phases delete or rewrite code that earlier
phases touch.

### Rule 2 — Read before you write

Before editing any RPC, module, or component named in this spec, **read it in full first**.
This repo has load-bearing details that are invisible from a name:

- `mark_patient_printed` and `upsert_camp_day` contain `FOR UPDATE` row locks and capacity
  guards. Rewriting either without reading it first silently removes concurrency protection.
- Several RPCs are `SECURITY DEFINER` with explicit `GRANT`/`REVOKE`. A dropped-and-recreated
  function **loses its grants**.

### Rule 3 — Postgres constraints you must respect

These are stated in `AGENTS.md` and are absolute:

1. **You cannot drop a value from an enum type.** `user_role` still lists `doctor` and
   `patient`; `queue_status` still lists `waiting`. They are dead labels. Do not try to
   remove them. Do not add new enum values unless this spec explicitly tells you to
   (it does not).
2. **`CREATE OR REPLACE FUNCTION` cannot change a return type, and changing the argument
   list creates a *second* overload rather than replacing the first.** If you change either,
   you must `DROP FUNCTION` the exact old signature explicitly, recreate it, and re-apply
   `REVOKE`/`GRANT`. Then verify in `pg_proc` that only one overload exists.
3. **Migrations are append-only.** Never edit an existing migration file. Never run
   `db reset` against anything but a disposable database.

### Rule 4 — Where a change is enforced

This app's convention (ADR 0015) is **the database is the refusal**. When this spec says a
thing is refused, the refusal lives in the RPC and returns a named error. The UI *also*
hides or disables the control, but the UI is never the only guard. Hiding a button is not
enforcement.

### Rule 5 — No code comments

`AGENTS.md` §8: no comments. Names and types carry the meaning. The single exception is a
non-obvious workaround, one line, with an issue link. Do not annotate this work with
explanatory comments.

### Rule 6 — What you can and cannot verify in your environment

You **can** run:

```bash
npm run lint && npx tsc --noEmit && npm test && npm run build && npm run check:js-budget
```

You **cannot** run `npm run test:db` or `npm run test:e2e` — both need Docker, which is not
available. This is why the test strategy pushes logic down to the unit seam (see **Testing
Decisions**).

You must still **write** the DB and e2e tests this spec asks for. You must **not** claim
they passed. When you report, state exactly which legs ran and which did not. Reporting a
partial pass as a full pass is a defect.

### Rule 7 — Two ambiguities are already decided for you

Do not re-open these. They are recorded in **Further Notes** as assumptions with rationale:

1. What happens to the surplus registration number on a Person merge.
2. Where the deferral T-1 reminder cron runs.

### Rule 8 — A trap that will catch you

**ADR 0014 is called `aadhaar-one-attempt.md`. It is NOT about how many retries a volunteer
gets.** It is about decode semantics: one scan attempt yields exactly one outcome (card,
garbage, or not-Aadhaar). It is unrelated to the 2-try manual-entry gate in Phase 1. Do not
change ADR 0014 and do not conflate the two.

---

## Problem Statement

Sikar Nagarik Parishad runs free eye camps. Volunteers, team leads and admins operate a desk
tracker that registers patients, prints their prescription paper, marks them seen, and hands
a clinical desk operator the job of transcribing the doctor's completed paper. Six things are
going wrong in the field:

1. **Volunteers see Print prescription on days when there is nothing to print.** The desk
   shows Register, Print and Scan from the moment a volunteer logs in, weeks before the camp.
   People print pre-registrations by mistake, then conclude the button is pointless. There is
   no way for an admin to say "printing starts now."

2. **The Aadhaar scan is a dead end for the patients who need help most.** A volunteer who
   cannot read a damaged or worn card has to find a team lead, because manual entry is locked
   to team leads and admins. Three failed attempts is too many to stand at a desk for.

3. **A manually-registered patient's identity is never confirmed.** They have no Aadhaar
   last-4, no date of birth, and no Person key — so One-Person-per-Aadhaar cannot see them,
   their clinical history cannot follow them across camps, and nothing at any point checks
   that the details typed weeks ago match the card they are carrying.

4. **Patients cannot read their own SMS.** Every message is Hinglish written in Latin script
   — `"SNP Camp: Reg #412. 12 Sep 2026 pe aana"`. Camp patients read Devanagari. They do not
   read Latin. The messages are, for the intended audience, unreadable.

5. **The clinical desk shows one operator everything.** Diagnoses, blood sugar, BP, remarks,
   medicines, a full spectacle power table, OT eye and procedure, and three separate
   fulfilment decisions, all on one screen. Four different people work four different lines
   in reality, and each of them has to navigate past the other three lines' fields.

6. **OT has one date and no capacity.** A surgeon can operate on a fixed number of eyes per
   day. The app offers a single admin-configured surgery date with no seat count, so there is
   no way to schedule across several days, nothing stops a date being over-committed, and the
   patient's slip cannot tell them which day is actually theirs.

## Solution

Six coordinated changes, plus a UX bar and a performance audit.

1. **A print window.** Print appears only when today is an active camp day *and* an admin has
   opened printing for that day. Before that, volunteers and team leads see Register only.

2. **Two attempts, then manual — and volunteers can do it.** The Aadhaar retry gate drops from
   three to two, and a volunteer may complete the manual exception themselves with a recorded
   reason. Admins get a per-camp list of every manual exception so overuse is visible.

3. **Camp-day Aadhaar confirmation.** A manual-exception patient must have their card scanned
   on a USB wedge scanner before their paper prints. The desk shows a before/after diff; the
   card wins on one tap. If the card resolves to a Person who already exists, the two records
   are merged after the operator confirms they are the same human.

4. **Hindi-only SMS with no links.** Three Devanagari DLT templates — registration, camp-day
   reminder, and one deferral template covering spectacles and OT at both issue and T-1. No
   URL appears in any message. The public status page is retired entirely.

5. **Clinical line stations.** An operator picks their line on opening the desk — fixed-power
   spectacles, medicine, spectacles-to-be-made, or OT — and sees only that line's fields and
   that line's decision.

6. **A real OT schedule.** Admins configure several OT dates, each with a seat count. A
   deferral takes the earliest date with a free seat; the operator can move the patient to any
   other date that still has seats. When every date is full the deferral is refused by name.
   The assigned date prints on the thermal slip and goes out by SMS at issue and again the day
   before.

---

## User Stories

### Print window

1. As an admin, I want printing to stay closed until I open it, so that volunteers cannot
   print prescriptions weeks before the camp.
2. As a volunteer, I want to see only a Register button before camp day, so that I am never
   confused about which of two buttons to press.
3. As a volunteer, I want Print prescription to appear on camp morning without me reloading
   or re-logging-in, so that I am not stuck when the admin opens the window.
4. As an admin, I want to close printing again mid-day, so that I can stop the desk when the
   printer fails or the doctor leaves early.
5. As an admin, I want every camp day to start with printing closed, so that yesterday's
   setting can never leak into today.
6. As an admin, I want the print window to be per camp day rather than per camp, so that a
   three-day camp is opened and closed one day at a time.
7. As a team lead, I want the print window to apply to me exactly as it applies to volunteers,
   so that the desk behaves the same for everyone working it.
8. As an operations lead, I want a bookmarked or back-buttoned print URL to be refused while
   printing is closed, so that presence is never stamped outside the window.
9. As an admin, I want the print window control to sit with the camp day it governs, so that
   I never open the wrong day by accident.
10. As a volunteer, I want a refusal that tells me printing is not open yet, so that I know to
    ask the admin rather than assume the app is broken.

### Aadhaar attempts and manual entry

11. As a volunteer, I want manual entry offered after two failed scans rather than three, so
    that a patient with a worn card is not kept standing at the desk.
12. As a volunteer, I want to complete a manual registration myself, so that I do not have to
    find a team lead in the middle of a queue.
13. As a volunteer, I want to be required to give a reason for a manual entry, so that there
    is a record of why the scan could not be used.
14. As an admin, I want a per-camp list of every manual exception with actor, reason and
    attempt count, so that I can see whether the manual path is being overused.
15. As a volunteer, I want the failed-attempt counter to reset for each new patient, so that
    the person after a difficult scan is not silently handed manual entry with no scan at all.
16. As a team lead, I want manual entry to keep working exactly as it does for me today, so
    that my workflow does not change.
17. As a clinical desk operator, I want to remain unable to register patients, so that station
    boundaries are preserved.

### Camp-day Aadhaar confirmation

18. As a volunteer, I want a manual-exception patient's card scanned before their paper
    prints, so that the record we treat as clinical is tied to a real card.
19. As a volunteer, I want the USB wedge scanner to be the input for that confirmation, so
    that I do not need a phone camera at the printing laptop.
20. As a volunteer, I want to see exactly which fields the card is about to change, so that I
    notice when the wrong card has been handed to me.
21. As a volunteer, I want a single tap to accept the card's version, so that confirmation
    costs me almost no time per patient.
22. As a team lead, I want to override a failed confirmation with a recorded reason, so that a
    patient with an unreadable card is not turned away from a free camp.
23. As an admin, I want each override recorded with actor, timestamp and reason, so that
    skipped confirmations are auditable after the camp.
24. As a data steward, I want the pre-overwrite values retained, so that we can tell what the
    volunteer originally typed.
25. As a data steward, I want a confirmed card to create the Person key that manual
    registration could not, so that One-Person-per-Aadhaar finally covers these patients.
26. As a clinical desk operator, I want a confirmed patient's history to follow them across
    camps, so that a returning patient's prior prescriptions are visible.
27. As a volunteer, I want to be told when the scanned card already belongs to another
    registration, so that I do not create a second record for one human.
28. As a volunteer, I want to see both records side by side before merging, so that I can
    confirm they are the same person.
29. As a volunteer, I want the merged patient to print under their permanent registration
    number, so that their paper matches their history.
30. As a volunteer, I want a patient who scanned their card at registration to skip
    confirmation entirely, so that only manual exceptions cost extra time.

### Aadhaar address authority

31. As a data steward, I want the card's address to win over any typed address on every scan,
    so that there is one authority for address across the whole app.
32. As a volunteer, I want the address field to lock after a scan like name and date of birth
    do, so that the rule is the same for every locked field.
33. As a patient self-registering online, I want my card's address used, so that my record
    matches my card without me typing anything.

### Hindi SMS

34. As a patient, I want my registration SMS written in Devanagari, so that I can actually
    read it.
35. As a patient, I want the SMS to be short and carry only my registration number, date and
    venue, so that nothing important is lost across message segments.
36. As a patient, I want no web links in my SMS, so that the message is not cluttered with
    text I cannot read or use.
37. As a patient, I want my camp-day reminder in Devanagari the day before, so that I do not
    forget to attend.
38. As a patient with deferred spectacles, I want an SMS telling me when and where to collect
    them, so that I do not lose the paper slip and miss it.
39. As a patient scheduled for surgery, I want an SMS with my assigned OT date and venue, so
    that I know which day is mine.
40. As a patient with a deferred item, I want a reminder the day before my date, so that a
    date weeks away is not forgotten.
41. As an operations lead, I want the number of DLT templates kept to three, so that approval
    is not the thing that delays the camp.
42. As an operations lead, I want message length checked against Unicode segment limits before
    sending, so that we are never surprised by a three-segment bill.
43. As a patient self-registering online, I want the confirmation on screen and no SMS, so
    that the existing behaviour I am used to is unchanged.

### Status page retirement

44. As an operations lead, I want the public status page removed entirely, so that there is
    one less unauthenticated surface to secure.
45. As a volunteer, I want to find a self-registered patient by name at the desk, so that a
    patient who lost their details can still be served.
46. As a volunteer, I want re-scanning a patient's Aadhaar to return their existing
    registration, so that recovery needs no lookup form at all.

### Clinical line stations

47. As a clinical desk operator, I want to choose my line when I open the desk, so that I see
    only the work I am doing.
48. As a fixed-power spectacles operator, I want to see only the spectacle power table and my
    own decision, so that I cannot accidentally record an OT outcome.
49. As a medicine operator, I want to see only the medicine list and my own decision, so that
    my screen is short enough to work through quickly.
50. As a spectacles-to-be-made operator, I want to see only my line's fields and decision, so
    that I am not scrolling past OT fields all day.
51. As an OT operator, I want to see only the OT eye, procedure, notes and my own decision,
    so that my screen matches my station.
52. As a clinical desk operator, I want my chosen line to persist across patients, so that I
    do not reselect it for every person.
53. As a clinical desk operator, I want to switch lines when I move stations, so that I am not
    locked into one choice for the session.
54. As a clinical desk operator, I want the line I am on shown at all times, so that I never
    record a decision on the wrong line.
55. As the first operator to open a patient, I want to type the shared clinical fields, so
    that no line is blocked waiting on another station.
56. As a later operator on the same patient, I want the shared clinical fields shown read-only,
    so that they are never typed twice or contradicted.
57. As an admin, I want corrections to shared fields to go through the existing reasoned
    correction path, so that the audit trail is unbroken.

### OT schedule

58. As an admin, I want to configure several OT dates, so that a camp's surgical load can be
    spread across days.
59. As an admin, I want a seat count on each OT date, so that a day cannot be committed beyond
    what the surgeon can do.
60. As an admin, I want a venue on each OT date, so that patients on different days can be
    sent to different places.
61. As an admin, I want to be refused when I lower a seat count below the number already
    assigned, so that I cannot orphan a scheduled patient.
62. As an OT operator, I want the earliest date with a free seat selected automatically, so
    that the default needs no thought.
63. As an OT operator, I want to move a patient to another date that still has seats, so that
    a patient who is travelling can be accommodated.
64. As an OT operator, I want full dates to be unselectable, so that I cannot overbook a day.
65. As an OT operator, I want a named refusal when every date is full, so that I know to ask
    the admin for a new date rather than assume a bug.
66. As an OT operator, I want the other three lines to keep working when OT is full, so that
    one blocked line does not stop the desk.
67. As an operations lead, I want seats reserved atomically, so that two operators deferring
    at the same moment cannot both take the last seat.
68. As a patient, I want my assigned OT date printed on my slip, so that I have it in writing.
69. As an admin, I want an already-issued slip to keep its date when I later change the
    schedule, so that a patient is never silently re-dated.
70. As an admin, I want spectacles collection to keep its single date and venue, so that a
    working part of the system is not disturbed.

### Thermal slip

71. As a patient, I want my slip printed in Devanagari, so that the paper matches the SMS and
    I can read both.
72. As an operations lead, I want the Devanagari font bundled with the app, so that a slip
    does not print blank on a laptop lacking the script.
73. As a patient with both spectacles and OT deferred, I want two separate slips, so that each
    instruction is on its own paper.
74. As a patient with nothing deferred, I want no slip printed, so that paper is not wasted.

### UX and performance

75. As a volunteer, I want one obvious primary action per screen, so that I never hesitate.
76. As a volunteer on a phone, I want the main button reachable without scrolling, so that the
    desk is fast in a queue.
77. As a volunteer, I want every refusal message to tell me what to do next, so that I am
    never stuck.
78. As a volunteer, I want touch targets big enough to hit reliably, so that I am not
    mis-tapping in bright sun.
79. As a field user, I want one script per surface, so that a screen is never half Hindi and
    half English.
80. As an operations lead, I want a ranked performance report with measured before-and-after
    numbers, so that optimisation work is evidenced rather than asserted.

---

## Implementation Decisions

### Phase 0 — Governance documents first

**Depends on:** nothing. **Do this before writing any code.**

`AGENTS.md` establishes that ADRs and `CONTEXT.md` outrank a spec. Several decisions here
contradict what those documents currently say. If the code lands first, the repo is
self-contradictory. Write the documents first, then implement against them.

**Write six new ADRs**, numbered 0020 through 0025 (0019 is the highest existing). Each
follows the existing ADR format in this repo: context, decision, consequences, and the
rejected alternative with the reason it was rejected.

| ADR | Subject | Rejected alternative to record |
|---|---|---|
| 0020 | Printing opens on a per-day admin switch behind a date floor | Deriving the window from the camp day date alone; a camp-level switch with no date floor |
| 0021 | The scanned card is authoritative; address locks on every scan | Card wins on identity only, address stays editable |
| 0022 | Manual exception at two attempts, available to volunteers | Team-lead-only at three attempts; server-tracked attempt counting |
| 0023 | SMS is Devanagari-only and link-free; the status token is retired | Keeping the link and accepting a mixed-script message; keeping the token dormant |
| 0024 | The clinical desk is four line stations | One screen showing all lines; splitting `specs` into two fulfilment kinds |
| 0025 | OT is scheduled across dated, seat-limited days | A single OT date; overflow past the seat count; auto-creating dates |

**Amend `CONTEXT.md`** at these specific entries:

- **Walk-in vs pre-reg** — replace `No desk mode toggle — the system uses the camp day date`
  with the date floor plus admin switch rule.
- **Manual registration exception** — three attempts becomes two; remove
  `Volunteers never receive manual identity fields`; keep the Clinical Desk Operator exclusion.
- **Aadhaar lock** — `Phone, address and camp day stay editable` becomes phone and camp day
  only. Address is locked by any scan.
- **Status token / status link** — remove the entry. Remove the **Patient lookup** entry.
  Remove status-link references from **Patient** and **Contact phone rule**.
- **Contact phone rule (Self-registration)** — keep the no-SMS rule and the database trigger,
  but restate the reason: recovery is desk name search and Aadhaar re-scan, not a status link.
- **Deferred fulfilment slip** — OT slips carry a scheduled date drawn from the OT schedule.
- **Prescription Transcription** and **Fulfilment item** — add the line-station model.
- Add new terms: **Print window**, **Aadhaar confirmation**, **Person merge**,
  **Clinical line**, **OT schedule day**, **OT seat**.

**Amend `AGENTS.md`** — the Status Token Boundary bullet and the Realtime/least-privilege
bullets that reference `patient_status_by_token`.

**Amend ADR 0008** — add a note that the 58mm deferred slip now prints Devanagari using a
bundled subset font, and that this is consistent with 0008's original reasoning (the failure
0008 guards against is the *machine* lacking the script; bundling the font removes that
dependency). Do not change 0008's decision about the A4 letterhead remaining an image.

**Do not touch ADR 0014.** See Rule 8.

---

### Phase 1 — Two attempts, and volunteers may use manual entry

**Depends on:** Phase 0.

This phase is small, self-contained, and touches no other phase. Do it first to build
confidence in the migration and test workflow.

**Introduce a single shared constant for the attempt threshold.** Today the number `3` is
written independently in the client component, the API route, and the RPC. Replace the two
TypeScript occurrences with one exported constant in a pure, dependency-free module so the
unit suite can assert against it. The RPC keeps its own literal because SQL cannot import
it; a database test asserts the two agree.

**Change the threshold from 3 to 2** in: the client counter's unlock condition, the API
route's validation, and the RPC's evidence check. Update the refusal message text, which
currently says "Three failed scans…".

**Open the role gate to volunteers.** Both the API route and the RPC currently require
`admin` or `team_lead`. Both must accept any Registration Staff role. The RPC should use the
existing `is_staff()` predicate rather than an inline role list, so there is one definition.
Clinical Desk Operators must remain excluded — verify `is_staff()` does exclude them before
relying on it, and if it does not, keep an explicit exclusion.

`register_manual_exception` keeps its exact argument list and return type, so `CREATE OR
REPLACE FUNCTION` is sufficient — **no drop, no re-grant**. Confirm this is still true after
your edit; if you find yourself changing a parameter, stop and follow Rule 3.2.

**Guarantee the per-patient counter reset.** The client currently increments a counter from a
scan-diagnostic effect. Verify that starting a new registration resets it to zero. If the
counter can survive into the next patient, that is a defect this phase must fix: patient two
would be offered manual entry with no scan attempted. Add a unit test for the reset.

**Add an admin manual-exceptions view.** A per-camp list showing, for each manual exception:
registration number, patient name, the actor who authorised it, the recorded reason, the
attempt count, and the timestamp. All four columns already exist on the patient row
(`manual_exception_actor`, `manual_exception_at`, `manual_exception_reason`,
`failed_scan_attempts`). This is a read-only admin surface — no new writes.

---

### Phase 2 — The print window

**Depends on:** Phase 0.

**Schema.** Add `printing_open boolean NOT NULL DEFAULT false` to the camp day row. It
defaults closed and each new camp day row therefore starts closed with no extra logic. Add
the new column to the readiness-contract catalogue, which enumerates expected columns and
will fail if it is not listed.

**Admin RPC.** Add a function that sets the flag for one camp day, callable by admins only.
Keep it separate from `upsert_camp_day` — that function carries a `FOR UPDATE` row lock and
a `SEAT_LIMIT_BELOW_ASSIGNED` capacity guard, and folding an unrelated flag into it risks
both. A small dedicated setter is simpler and safer.

**The predicate.** Printing is open when **both** are true:

1. The camp day's date is today in `Asia/Kolkata`.
2. That camp day's `printing_open` is true.

Extract this as a pure function taking the day date, the flag, and the current time, and
returning a boolean. Put it in a DB-free module. This is the single most-tested piece of
logic in the phase — timezone boundaries, the flag off on the correct date, the flag on for
the wrong date.

**Database enforcement.** `mark_patient_printed` stamps presence. **Read it in full before
editing.** Add the print-window check, and preserve its existing lock ordering exactly.
Return a distinct, greppable error identifier for this refusal so the client can map it to a
Hinglish message. Do not reuse an existing error string.

**Route enforcement.** The print page is a plain URL. It must server-check the window and
render a refusal card rather than attempting the print. This is defence in depth; the RPC
check above remains the real guard.

**Desk UI.** When the window is closed, volunteers and team leads see a single Register
action. When open, they see Register, Print prescription and Mark seen. The desk already
polls (there are no realtime channels on patient rows — see the Realtime Boundary rule), so
the window state must ride the existing poll. **Do not add a new polling loop and do not add
a WebSocket channel.**

Mark seen sits behind the same window. A patient cannot be marked seen without presence, and
presence cannot exist while the window is closed, so showing Mark seen with printing closed
would only ever produce a refusal.

---

### Phase 3 — Camp-day Aadhaar confirmation and Person merge

**Depends on:** Phases 1 and 2. This is the most intricate phase. Read all of it before
starting.

**Background you need.** `register_manual_exception` calls `register_patient_idempotent`
passing nulls for Aadhaar last-4, date of birth and Person key, then stamps
`provenance = 'manual_exception'`. So a manual-exception patient has a Person row whose
`duplicate_key` is **null**. `persons.duplicate_key` carries a `UNIQUE` constraint.

**The Person key is derived in Node, not in SQL.** Key derivation is
`HMAC-SHA256` over last-4 + normalised name + date of birth + gender, using a pepper from the
environment. Per ADR 0017, server-only crypto stays out of client-reachable modules. The
server derives the key and passes it to the RPC as a parameter. **The RPC must never attempt
to derive the key itself.**

**Who needs confirmation.** Only patients whose provenance is `manual_exception` **and** whose
Person key is null. A patient who scanned at registration already has a key and is untouched
by this phase.

**Flow.**

1. Volunteer opens a manual-exception patient to print. The desk shows a confirmation step
   instead of the print action.
2. Volunteer scans the card on the USB wedge scanner. This reuses the existing wedge input
   path — do not build a second scanner.
3. Server parses the card, derives the key, and calls a new RPC in **inspect** mode: it
   mutates nothing and returns either `free` (key unused) or `collision` with the conflicting
   Person's registration number, name, age and gender.
4. The desk renders a before/after diff: typed values on the left, card values on the right,
   changed fields highlighted. On a collision it renders both records side by side and asks
   the operator to confirm they are the same human.
5. Operator taps accept. The server calls the same RPC in **commit** mode.
6. Print proceeds.

**Commit-mode behaviour, key free:** attach the key to the existing Person, overwrite legal
name, date of birth, gender, Aadhaar last-4 and address; recompute age from the date of
birth; retain the pre-overwrite values; clear the pending-confirmation state.

**Commit-mode behaviour, key taken:** repoint the patient row to the surviving Person, apply
the same field overwrites, and return the surviving Person's permanent registration number.
The surplus Person row is **not deleted** — see Further Notes.

**Both modes must take a row lock on the surviving Person before reading the key**, so two
desks confirming the same card cannot both see it as free.

**Latin display name.** If the card name is non-Latin, the Latin name already typed at manual
registration is promoted to the display name for the printed sheet and name search. Do not
prompt for it again — it exists.

**Team Lead override.** When the card will not scan, a team lead or admin records a reason and
prints without confirmation. The patient stays unconfirmed with a null key. Record actor,
timestamp and reason. The override is refused for volunteers — this is the one part of Phase
1's role widening that does **not** extend to volunteers, because it is the escape hatch from
the escape hatch.

**Address authority is app-wide.** Per Phase 0's ADR 0021, a scanned card's address wins and
locks everywhere: desk registration, self-registration, and this confirmation. Address joins
name, date of birth, gender and last-4 in the read-only locked set. Phone and camp day stay
editable.

---

### Phase 4 — Retire the status page

**Depends on:** Phase 0. Do this **before** Phase 5, because the registration SMS currently
embeds the status link and Phase 5 rewrites that message.

This is an **explicitly authorised irreversible migration**, on the stated basis that no real
camp has run and production holds test data only. This mirrors the one-time exception of
migration `20260728119000` and **sets no precedent**. Record that framing in ADR 0023.

**Validate by clean replay on a disposable database before proposing it as final.** You cannot
run that here — write the migration, say plainly that replay was not run, and flag it for the
Docker gate.

**Remove, in this order:**

1. The status link from the registration SMS variables and template.
2. The status page route, the patient lookup page and its API route, and the status
   rate-limit API route.
3. The status auto-refresh component, the status view module, and the patient status guidance
   module. Check for other importers before deleting each one — delete dead code as you pass
   it, but do not break a live import.
4. Public rate-limit configuration for status tokens and the per-token/per-IP limits.
5. `REVOKE` and `DROP` the `patient_status_by_token` function using its exact signature.
6. Drop the status token column from the patient row.
7. Remove the column and function from the readiness contract catalogue.

**Do not remove:** self-registration, its rate limits, its Person-key path, its on-screen
receipt, or the database trigger that keeps self-registration SMS-free. The receipt keeps
showing registration number, patient QR, camp day and venue — it simply no longer shows a
status link.

**Do not remove:** the patient QR on the prescription sheet. That encodes a staff-scan path
and is unrelated to the status token.

---

### Phase 5 — Devanagari SMS

**Depends on:** Phase 4.

**Replace GSM-7 enforcement with Unicode segment counting.** The current helper throws on any
non-GSM-7 character, which would reject every Devanagari message. Replace it with a function
that computes UCS-2 segment count: 70 characters for a single segment, 67 per segment when
concatenated. Export a maximum-segment constant and refuse to send above it. Keep this module
pure and DB-free — it is prime unit-seam material.

**Venue truncation must become script-aware.** The current helper truncates to 35 characters
and strips anything non-GSM-7 — against a Devanagari venue that strips the entire string.
Rewrite it to truncate on Unicode code points without stripping, and to fall back to a
Devanagari placeholder rather than the current Latin one.

**Date formatting must become Devanagari.** The current formatter emits Latin month names.
Add Devanagari month names. **Keep digits as ASCII** — desk staff compare registration numbers
and dates against Latin digits on paper, and Devanagari numerals would make that harder.

**Three DLT templates**, all Devanagari, all link-free:

1. **Registration** — registration number, camp date, venue.
2. **Camp-day reminder** — registration number, camp date, venue. Unchanged trigger.
3. **Deferral** — service name, date, venue. Its service-name variable carries the Devanagari
   word for spectacles or operation, so this one template serves spectacles and OT, at both
   issue and T-1.

Draft the exact Hindi wording as part of this phase and surface it for approval. **DLT
registration is the operator's job, not yours** — the code must read template ids from
environment variables exactly as it does today, and must degrade safely when they are unset
(the existing configured-check pattern already does this).

Add an environment variable for the deferral template id alongside the two that exist, wire
it into the readiness/env checks, and add it to the env example file.

---

### Phase 6 — Clinical line stations

**Depends on:** Phase 0.

**No schema change. No new fulfilment kind. No enum change.** The three kinds stay as they
are. Fixed-power and to-be-made remain the `fulfilled` and `deferred` outcomes of the single
spectacles item. This is a presentation and flow change only.

**Four lines**, each mapping to an existing kind-and-outcome pair:

| Line | Kind | Decision offered |
|---|---|---|
| Fixed-power spectacles | `specs` | fulfilled, not required |
| Medicine | `medicine` | fulfilled, not available, not required |
| Spectacles to be made | `specs` | deferred, not required |
| OT | `ot` | fulfilled, deferred, not required |

Note the two spectacles lines resolve the same underlying item. An operator on one line must
be refused if the other has already resolved it — the existing outcome-conflict refusal
already covers this; map it to a clear Hinglish message naming the other line.

**Line selection** is chosen when the desk opens, persisted locally so it survives reloads and
carries across patients, and switchable at any time. The active line must be visible on screen
at all times, not just at selection.

**Field visibility per line:** each station sees its own detail fields only — the power table
for both spectacles lines, the medicine list for medicine, eye/procedure/notes for OT.

**Shared clinical fields** — diagnoses, blood sugar, blood pressure, remarks — are editable
only while no transcription has been saved for that patient. Once saved they render read-only
on every station. This needs no new server rule: the transcription row's existence is the
signal, and the existing admin reasoned-correction path handles changes. Do not invent a new
lock.

**Do not remove** the existing single-screen behaviour for admins if admins rely on it for
review; scope the line stations to the Clinical Desk Operator surface.

---

### Phase 7 — OT schedule with seats

**Depends on:** Phases 0 and 6.

**Read `upsert_camp_day` before writing any of this.** It is the template: it takes a row
lock, counts what is already assigned, and refuses a seat limit below that count. Mirror that
structure exactly. `AGENTS.md` calls this out by name.

**New table — OT schedule day.** Columns: id; camp id (FK); date; venue (text, not null);
seat limit (integer, not null, non-negative). Unique on camp id plus date. Add it to the
readiness contract catalogue.

**Seats taken is derived, never stored.** Count the OT fulfilment items assigned to that
schedule day and still deferred. A stored counter drifts; a count under a row lock does not.

**Fulfilment items gain a nullable reference** to the OT schedule day. Null for every non-OT
item and for OT items that are fulfilled or not required.

**Admin RPC** to create and update a schedule day, admin-only. It must refuse a seat limit
below the number already assigned, reusing the existing `SEAT_LIMIT_BELOW_ASSIGNED` refusal
identifier so the client's error mapping is shared.

**Selection logic is a pure function.** Given a list of schedule days with their seat limits
and taken counts, return the earliest date with a free seat, or nothing. This is DB-free and
unit-tested: earliest-first ordering, skipping full days, all-full, empty list, ties.

**Deferral flow.** `clinical_resolve_item` gains an optional schedule-day parameter. Changing
its argument list means **you must `DROP` the exact old signature, recreate it, and re-apply
`REVOKE`/`GRANT`** — see Rule 3.2. Verify in `pg_proc` that exactly one overload survives.

When resolving an OT item to deferred:

- If no schedule day is supplied, pick the earliest with a free seat.
- Lock the chosen schedule day row `FOR UPDATE`, then count assigned items, then compare to
  the seat limit, then insert. In that order. This is what makes concurrent deferrals safe.
- If the chosen day is full by the time the lock is held, refuse — do not silently move the
  patient to another day, because the operator was shown a specific date.
- If no day has a free seat, refuse with a distinct identifier mapping to
  `"Saari OT dates bhar gayi — admin se nayi date add karwayein."`
- Refusal affects the OT line only. Transcription saving and the other three lines continue
  to work. This matches the existing deferral-readiness rule.

**Operator override.** The desk shows a date selector defaulted to the auto-selected day,
listing only days with free seats. Full days must not be selectable.

**Slip snapshot is unchanged.** An issued slip keeps the date and venue copied into it. Later
schedule edits affect only future deferrals. This rule already exists — reuse it, do not
reimplement it.

**Spectacles collection is untouched.** It keeps its single admin date and venue.

---

### Phase 8 — Deferral SMS and the T-1 reminder

**Depends on:** Phases 5 and 7.

**Two triggers**, both using the single deferral template from Phase 5:

1. **At slip issue** — when the clinical desk prints a deferred spectacles or OT slip.
2. **One day before** the slip's date.

**Use the existing SMS delivery ledger.** It already provides claim tokens, dispatch-started
marking, attempt counting and completion. Add a new delivery kind for deferral messages rather
than inventing a parallel mechanism. Idempotency comes from the ledger — a reprinted slip must
not re-send.

**Extend the existing reminder cron route** rather than adding a second one. It already runs
daily and sends camp-day reminders. Add a second query for deferred items whose date is
tomorrow. One cron route, two queries, one shared send path. Rationale is in Further Notes.

**Both spectacles and OT deferrals get both messages.** Medicine follow-up sends no SMS and
prints no slip — that rule is unchanged.

**A patient with both items deferred receives two slips and two messages**, one per item, as
they already receive two slips today.

---

### Phase 9 — Devanagari thermal slip

**Depends on:** Phases 5 and 7.

The 58mm slip already exists and is already thermal-sized. Convert its text to Devanagari.

**Bundle a subset Devanagari font with the app and self-host it.** ADR 0008's warning is that
a printing machine lacking the script prints nothing; bundling removes that dependency because
the browser rasterises with a font it already has. Subset to the glyphs actually used so the
payload stays small.

**Do not let the font touch other routes' budgets.** Scope it to the slip route. `npm run
check:js-budget` enforces per-route budgets and must still pass.

**Keep registration numbers, dates and measurements in ASCII digits**, consistent with the SMS
decision.

**The OT slip's date and venue now come from the assigned schedule day**, not the single admin
setting. The spectacles slip continues to use the single collection setting.

**This phase has a manual gate the operator must clear: a physical print test on the real 58mm
printer.** You cannot do this. State it as an outstanding blocker in your report. A silently
blank slip is worse than a Latin one.

---

### Phase 10 — UX bar and static performance audit

**Depends on:** Phases 1 through 9.

**The UX bar is not a redesign.** It applies to the screens the preceding phases already
rewrite: the volunteer desk, the confirmation diff, the clinical line stations, and the admin
camp-day and OT-schedule settings. Do not redesign screens no phase touched.

Checkable rules:

- One primary action per screen; secondary actions visually subordinate.
- The primary action reachable without scrolling at a 375px-wide viewport.
- Interactive targets at least 44×44 CSS pixels.
- Visible focus rings; `prefers-reduced-motion` respected; press feedback via `scale(0.98)`.
- Every refusal message names the next action.
- One script per surface: patient and field-staff surfaces Hinglish or Hindi, admin English.
  Never mixed within one surface.
- WCAG 2.2 AA contrast, for bright outdoor light.

**Performance audit.** Deliver a ranked report as a Markdown file under `docs/`. Measure only
what is measurable without a running app or database:

- Per-route eager and async client JS from the production build.
- Client/server component split; anything client-side that need not be.
- Render-blocking imports and heavy modules not deferred.
- Query shapes in the hot desk paths: N+1 patterns, over-fetching, missing indexes on
  filter and join columns.
- Avoidable round-trips, especially any this spec's phases introduce.

Rank by estimated impact against implementation cost. **Fix the top five. Stop there.** Prove
each with before-and-after numbers from `npm run check:js-budget` and the build output. If a
finding cannot be proven with an offline measurement, report it as unverified rather than
claiming an improvement.

**Do not** run Lighthouse, start a dev server, open a browser, or claim real page-load or
query timings. Those are unavailable and asserting them would be fabrication.

---

### Phase 11 — The gate

**Depends on:** everything.

`AGENTS.md` §9 defines done. Work through it:

1. Run what you can:
   ```bash
   npm run lint && npx tsc --noEmit && npm test && npm run build && npm run check:js-budget
   ```
2. Run the two adversarial reviews as parallel subagents, 15k budget each, correctness and
   simplicity, at most three findings each, worst first. Both are told to return "no findings"
   rather than invent something.
3. Fix every confirmed finding, or decline it with a stated reason.
4. Re-run the suite after the fixes.
5. Confirm the Phase 0 documents match what you actually built. If implementation diverged
   from a document, amend the document in this same change.

**Report honestly.** State which legs ran and which did not. Report skip counts explicitly.
Name the outstanding manual gates: clean-replay validation of the Phase 4 migration, the
`test:db` and `test:e2e` legs, the Phase 9 physical printer test, and DLT approval of the
three Devanagari templates. Do not describe the work as verified end-to-end. It will not be.

---

## Testing Decisions

### What makes a good test here

Assert **external behaviour**, not implementation. `CONTEXT.md` is explicit that source-text
regex assertions are discouraged: they break on rename and pass on rot. A test should describe
something a user or caller can observe — a refusal, a returned value, a rendered control.

For every bug this spec fixes, and for every refusal it adds, **show the test failing before
the fix and passing after**. A test written after the code, that has never been red, has
proven nothing.

**A skipped database test is a failure, not a pass.** `npm run test:db` fails the run on any
skip and names it a blocker. A file may skip only when the database is genuinely unreachable.
**Never write a guard that treats a missing RPC as "Postgres unavailable"** — that silently
deletes coverage at exactly the moment a migration breaks something, and it has already
happened in this repo.

### Seam allocation

Three existing seams. No new seams. Logic is pushed as far down as possible so the cheapest,
runnable seam carries the most weight.

**Unit seam — `tests/*.test.mjs`, DB-free and skip-free per ADR 0018. This is the primary
seam and the one you can actually run.**

To use it you must extract decisions into pure modules. Each of these is a pure function with
no database and no React:

| Logic | Cases to cover |
|---|---|
| Print-window predicate | flag on/off × date today/not today; `Asia/Kolkata` midnight boundaries |
| Attempt threshold constant | the exported value is 2; client and API agree |
| Attempt counter reset | a new registration zeroes the count |
| Typed-vs-card diff | no change; one field; all fields; non-Latin name promoting a display name |
| UCS-2 segment counting | 70-char boundary; 67-per-segment concatenation; the max-segment refusal |
| Devanagari venue truncation | long venue; Devanagari not stripped; empty falls back to the Devanagari placeholder |
| Devanagari date formatting | each month; ASCII digits retained; malformed input passes through |
| Registration/reminder/deferral template filling | variable order and count match the DLT body |
| OT day selection | earliest free; skip full; all full; empty list; ties |
| Line-to-kind-and-outcome mapping | each of the four lines offers exactly its allowed decisions |

**Database seam — `tests/*.db.test.mjs`.** Write these; you cannot run them. Restrict to
things only the database can prove:

- `mark_patient_printed` refuses while the print window is closed, and succeeds when open.
- Presence is still written once and idempotently; a reprint keeps the original timestamp.
- `register_manual_exception` accepts a volunteer, refuses a Clinical Desk Operator, and
  refuses fewer than two attempts.
- The RPC's attempt literal matches the exported TypeScript constant.
- Aadhaar confirmation attaches a key when free; detects a collision without mutating in
  inspect mode; merges on commit and returns the surviving registration number.
- Two concurrent confirmations of the same card do not both succeed.
- OT deferral reserves a seat atomically; two concurrent deferrals cannot take the same last
  seat; a full schedule refuses by name; lowering a seat limit below assigned is refused.
- `patient_status_by_token` no longer exists and the status token column is gone.
- The self-registration no-SMS trigger still fires.
- `pg_proc` holds exactly one overload of `clinical_resolve_item`.

**E2E seam — `e2e/*.spec.ts`.** Write these; you cannot run them. Restrict to role-visible
gating that only a rendered page proves:

- A volunteer sees Register only while the window is closed, and Register plus Print plus
  Mark seen when open.
- A team lead sees the same as a volunteer.
- A volunteer reaches manual entry after two failed scans.
- The print URL renders a refusal card while the window is closed.
- Each clinical line station shows only its own fields and decisions.
- Shared clinical fields are editable for the first station and read-only after saving.

### Prior art to copy

Follow the shape of tests already in the repo rather than inventing conventions:

- Registration and reminder SMS unit tests, for the template and formatting work.
- Admin settings unit tests, for the camp-day and OT-schedule validation work.
- The SMS deliveries database tests, for ledger, claim and attempt-count assertions —
  directly reusable for Phase 8.
- The staff-person KPI database tests, for the patient-fixture helper pattern.
- The register-and-print e2e spec, for the desk role journeys.

---

## Out of Scope

- **Any third lifecycle state.** The lifecycle stays `registered → seen`. ADR 0013 stands.
  Presence remains `printed_at`, not a status. No queue, no line, no position.
- **A third desk action.** Print prescription and Mark seen remain the only two. The print
  window changes when they are *visible*, not how many there are.
- **Realtime channels on patient rows.** The `patients` table stays absent from the realtime
  publication. Everything polls.
- **Patient authentication.** Patients still do not sign in and hold no session.
- **Splitting the spectacles fulfilment kind.** Explicitly rejected in ADR 0024.
- **Multi-date spectacles collection.** OT only.
- **Auto-creating OT dates, or overflowing past a seat count.** Both rejected in ADR 0025.
- **Server-side Aadhaar attempt tracking.** Rejected; the counter stays client-side and the
  control is accountability.
- **Aadhaar signature verification or eKYC.** The system still verifies nothing. ADR 0004
  stands.
- **Redesigning screens no phase in this spec touches.**
- **Lighthouse scores, real page-load timings, live query timings.** Not measurable here.
- **DLT template registration.** An operator task on the TRAI portal.
- **The physical 58mm printer test.** An operator task.
- **Full-number Aadhaar storage.** Still last-4 only.

---

## Further Notes

### Decided assumptions — do not re-open

**1. The surplus registration number on a Person merge is retired as an alias, not deleted.**

When the confirmation scan merges registration 412 into the pre-existing Person holding
registration 87, the surplus Person row is **kept** and marked as merged with a pointer to the
survivor. The number 412 is never reissued, and looking it up resolves to the surviving Person.

Chosen because deletion is irreversible, because the patient may be holding an SMS quoting 412,
and because this repo's ethos is append-only history over destructive edits. The patient's
paper prints the permanent number, 87. Rejected: hard-deleting the surplus row; reusing 412
for a future patient.

**2. The deferral T-1 reminder runs on the existing reminder cron route.**

One daily cron, two queries, one shared send path. A second route would mean a second schedule,
a second secret and a second failure mode for the same job. Rejected: a dedicated deferral cron
route.

### Where things live today

The template for this spec asks for no file paths, because paths go stale. This orientation
list is a deliberate exception, added because the executor benefits from a starting point more
than it suffers from mild staleness. **Verify each before relying on it — they were accurate on
2026-08-16 and are a starting point, not a contract.**

- Manual registration API route: `src/app/api/desk/register-manual/route.ts`
- Manual registration RPC: `register_manual_exception`, defined in
  `supabase/migrations/20260731090000_adversarial_deep_review_remediation.sql`
- Registration form and attempt counter: `src/components/patient-form.tsx`
- USB wedge input: `src/components/aadhaar-usb-input.tsx`; scanner hook:
  `src/components/use-aadhaar-scanner.ts`
- Person key derivation: `src/lib/person-duplicate-key.ts`
- Persons table and the patient FK: `supabase/migrations/20260727210000_person_entity_expand.sql`
- Desk RPC wrappers: `src/lib/desk-ops.ts` — `mark_patient_printed`, `mark_seen`,
  `undo_mark_seen`, `lookup_patient_scan`, `change_camp_day`, `search_desk_patients`
- Clinical desk: `src/components/clinical-desk.tsx` — `clinical_lookup`,
  `clinical_save_transcription`, `clinical_resolve_item`, `clinical_add_correction`,
  `clinical_replace_slip`, `clinical_followup_lookup`, `clinical_followup_fulfil`
- Thermal slip route: `src/app/clinical/slip/[id]/page.tsx` (58mm)
- SMS: `src/lib/registration-sms.ts`, `src/lib/reminder-sms.ts`, `src/lib/msg91.ts`,
  ledger in `src/lib/sms-deliveries.ts`
- Reminder cron: `src/app/api/cron/reminder-sms/route.ts`
- Camp settings: `src/lib/admin-settings.ts`; camp days UI: `src/components/admin-camp-days.tsx`
- Readiness contract catalogue: `src/lib/readiness-contract.ts`
- Bundle budgets: `scripts/check-js-budget.mjs` with `js-route-budgets.json`

### Critical path

**DLT approval of the three Devanagari templates gates the SMS work reaching production.** It
is a portal round-trip measured in days and it is not yours to run. Draft the wording early in
Phase 5 and hand it over immediately, so approval runs in parallel with Phases 6 through 10
rather than after them.

### Ordering rationale

Phase 4 precedes Phase 5 because the registration SMS carries the status link that Phase 4
deletes; rewriting the message twice would be waste. Phase 7 follows Phase 6 because the OT
date selector lives inside the OT line station. Phases 8 and 9 follow both 5 and 7 because
each needs the Devanagari pipeline and the assigned schedule day. Phase 1 is first among the
code phases because it is small and self-contained, and completing it establishes the
migration, test and review workflow before the intricate phases begin.
