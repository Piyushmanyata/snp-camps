# Spec: No FCFS Queue, one Aadhaar attempt, Clinical Desk refusals

**Date:** 2026-08-13
**Status:** ready for agent
**Governs:** implement ADRs 0013, 0014, 0015 in that order
**Does not reopen:** ADR 0004, 0008 (paper + two desk actions), 0009, 0011, 0012

A spec is a work order. ADR 0013 already amended the lifecycle in `CONTEXT.md` and `AGENTS.md`. This spec must not contradict those documents. `README.md` camp-flow still describes the old line and must be amended in the same change as Phase 1.

---

## Problem Statement

The Volunteer Desk is harder than the camp. Printing a prescription writes `waiting` in three different places, so a scan can queue someone twice. Volunteers are asked to watch a Live Queue they do not run the hall from. Patients see a position number that is not how the line actually works.

Aadhaar scan fails on good cards because the phone’s built-in reader returns text, the app treats that as done, and the backup reader that understands the real binary QR never runs.

On the Clinical Desk, the screen checks the form with one set of rules and the database with another. When the database says no, the operator only sees “try again.” Diagnosis checkboxes vs Other show differently on the desk, in history, and in the Excel export.

---

## Solution

**Phase 1 — Print first.** There is no FCFS Queue and no Live Queue panel. Lifecycle is `registered → seen`. Print prescription prints the paper and records presence (`printed_at`) once. Mark seen still refuses a never-printed Registration. The status page shows camp day, venue, and `registered` or `seen` — no position.

**Phase 2 — Aadhaar.** One attempt, one outcome. The decoder is given the picture and whatever the phone reader said. It tries that as a hint, then the binary reader. The registration form decides whether the card is complete enough to lock. One camera opener; Aadhaar and Patient QR keep separate readers.

**Phase 3 — Clinical Desk.** The database is the no. The form may highlight empty boxes. Save, correct, and resolve show the database’s reason in Hinglish. Desk, history, and Camp Records Export all read the stored diagnosis split. An unchanged correction is a screen hint, not a database JSON compare.

---

## User Stories

1. As a volunteer, I want Print prescription to print the paper and remember they showed up, so that a jammed printer does not lose them and I am not managing a digital line.
2. As a volunteer, I want a reprint to keep the original `printed_at`, so that reprinting never looks like a second arrival.
3. As a volunteer, I want register-only to save the Registration without setting `printed_at`, so that a walk-in who is not yet printed cannot be marked seen by mistake.
4. As a volunteer, I want register-and-print to save and then print in one desk visit, so that a walk-in today still leaves with paper and presence in one gesture.
5. As a volunteer, I want registering a future Camp Day to stay `registered` with no print and no `printed_at`, so that pre-reg is not treated as present.
6. As a volunteer, I want scanning a Patient QR and choosing Print prescription to set `printed_at` once before the sheet opens, so that a blocked print window still counts as present.
7. As a volunteer, I want the sheet’s print action not to invent a second arrival, so that scan-then-sheet cannot write presence twice.
8. As a volunteer, I want “Print for them instead” on a likely-duplicate to print the existing Registration, so that I do not create a second Person and I do not talk about a queue.
9. As a volunteer, I want Mark seen to refuse a Registration that was never printed for, so that a mis-scan names its reason.
10. As a volunteer, I want a double Mark seen to keep the original `seen_at`, so that a second scan is safe.
11. As a volunteer, I want Undo mark seen within ten minutes (and only with no Prescription Transcription) to return the patient to `registered` and keep `printed_at`, so that I do not have to reprint to mark them seen again.
12. As a volunteer, I want Undo to fail after a Clinical Desk Operator has started a Prescription Transcription, so that clinical history cannot be silently rewound.
13. As a volunteer, I want the Volunteer Desk to show Print prescription and Mark seen without a Live Queue panel, so that I am not watching a list the hall does not use.
14. As a volunteer, I want name-search to find `registered` and `seen` patients, so that a lost-paper recovery still works.
15. As a volunteer, I want self-registration arrivals to stay `registered` until I print them, so that someone who registered on their phone is not treated as present.
16. As a team lead, I want walk-in seat caps to stay “pre-reg only,” so that a person standing at the desk is never turned away because a number is full.
17. As an admin, I want the seat board to keep counting every Registration on the Camp Day, so that capacity is still visible without a line.
18. As an admin, I want staff KPIs that used to count `waiting` to stop doing so, so that leaderboards do not invent a dead state.
19. As a patient, I want `/s/<token>` to show camp day, venue, and whether I am `registered` or `seen`, so that I know my day without a fake position.
20. As a patient, I want the status page never to say I am “in the hall” or show a queue number, so that public status matches the two-state lifecycle.
21. As a patient, I want a `seen` status to stay `seen` after I reprint my paper, so that paper and status do not fight.
22. As a volunteer, I want Hinglish copy on the desk to say print and mark seen, never “queue,” “line,” or “check-in,” so that the screen matches how we work.
23. As a volunteer, I want a `seen` patient to still be allowed a paper reprint, so that a lost sheet can be replaced.
24. As an implementer, I want residual `waiting` rows treated as `registered` for presence (use `printed_at`, never promote `waiting`), so that old test data does not reappear as a line.
25. As an implementer, I want the `waiting` enum value left in Postgres, so that we do not attempt an impossible enum drop.
26. As a volunteer, I want the Aadhaar camera to try the phone reader and then the binary backup on the same picture, so that a mangled text hit does not kill a good card.
27. As a volunteer, I want taking a photo of the Aadhaar card to use that same one-attempt decoder, so that photo-first (ADR 0012) is not a second stack.
28. As a volunteer, I want the USB Aadhaar wedge to produce the same card-or-nothing outcome, so that laptop capture matches the phone.
29. As a volunteer, I want a partial Aadhaar read to fill what it can and keep the camera open until name, age, gender, last-4, and date of birth are all present, so that a blurry frame does not lock a half identity.
30. As a volunteer, I want the Aadhaar lock to apply only when those identity fields are complete, so that an empty last-4 from an old card is still typeable.
31. As a patient on self-registration, I want nothing filled until the card is complete, so that I do not submit a half-read identity.
32. As a volunteer, I want “not an Aadhaar card” (including our own Patient QR) to stop the Aadhaar session with a clear reason, so that I scan the right code on the right camera.
33. As a volunteer, I want Patient QR scan (print / mark seen) to keep the cheap id reader, so that dense Aadhaar decode is not paid on every desk slip.
34. As a volunteer, I want Aadhaar capture and Patient QR capture to share camera start / focus / stop, so that zoom and autofocus do not drift apart.
35. As a Clinical Desk Operator, I want empty-box hints before save, so that I do not wait on the network for a blank field.
36. As a Clinical Desk Operator, I want save / correct / resolve failures to show the database’s reason in Hinglish, so that I know whether I forgot Specs numbers, date/venue, or a lock.
37. As a Clinical Desk Operator, I want the screen not to invent a second copy of database rules, so that what saves is what the database allows.
38. As a Clinical Desk Operator, I want diagnoses I saved (options + Other, including retired labels) to come back the same, so that a later template edit does not rewrite history.
39. As an admin, I want Camp Records Export columns to use that same stored split, so that Excel matches the desk.
40. As a Clinical Desk Operator, I want history for the same Person to use that same stored split, so that last camp and this camp do not disagree.
41. As a Clinical Desk Operator, I want “add correction” with no field change to tell me to change something first, so that I do not file an empty amendment.
42. As a Clinical Desk Operator, I want a reasoned correction that does change fields to still lock through the database, so that fulfilment history stays append-only.
43. As a Clinical Desk Operator, I want deferred Specs/OT slips to still print after a successful defer, so that the patient leaves with instructions.
44. As a Registration Staff member, I still cannot open clinical records, so that the Clinical Desk stays least-privilege (ADR 0009).
45. As a Clinical Desk Operator, I still cannot register, print the A4 sheet, or mark seen, so that the Volunteer Desk stays the only place for those two actions.

---

## Implementation Decisions

**Order:** Phase 1 (ADR 0013) ships before Phase 2 (ADR 0014) and Phase 3 (ADR 0015). Do not mix phases in one change if that hides a red lifecycle test.

**Phase 1 — lifecycle**

- Print prescription is one module: print paper + set `printed_at` once. Scan print, register-and-print, likely-duplicate print, and sheet reprint all go through it.
- `register_patient_idempotent` must not set `waiting` (or `queued_at` as a line) for today’s walk-in. Walk-in today stays `registered` until Print prescription runs.
- Presence is `printed_at`. `queued_at` is not a line position. Do not add a third lifecycle state.
- Mark seen requires `printed_at`. Refusal copy is “never printed,” not “not in queue.”
- Undo restores `registered` and keeps `printed_at`. Ten-minute window and Prescription Transcription lock stay.
- Remove the Live Queue panel from the Volunteer Desk (and the admin desk equivalent). Seat board stays.
- Status token returns camp day, venue, `registered` or `seen`. Strip position and any `waiting` metric.
- Treat leftover `waiting` rows as not a line: do not display them as a queue; do not write new ones. Postgres keeps the enum value.
- Append-only incremental migration only. No production reset. Do not drop `waiting` from the enum.
- Amend `README.md` camp flow in the same change so it does not contradict ADR 0013.
- Desk copy: Hinglish. No “queue,” “line,” or “check-in.”

**Phase 2 — Aadhaar**

- One decode-attempt module: picture + optional phone-reader text → one outcome (`parsed` card, garbage, or not-Aadhaar).
- Phone-reader text is a hint, not a final success. Binary backup still runs unless a real Aadhaar card was parsed.
- Capture screen starts the camera and applies the outcome. It does not decide completeness.
- Desk form: may fill a partial; lock only when name, age, gender, last-4, and date of birth are all present.
- Self-registration: all five or nothing.
- One camera-opener module (start, focus, stop, generation). Two readers: Aadhaar decoder vs Patient QR id parse. Do not merge the readers.
- Photo path and USB wedge use the same attempt/outcome. ADR 0012 photo-first stays primary on phones.

**Phase 3 — Clinical Desk**

- Delete the parallel “mirror the SQL” browser validator as a second source of truth. Empty-box hints may remain.
- Map database refusal text to Hinglish for save, correct, and resolve. Do not swallow the reason.
- One diagnoses reader of the stored `{options, other}` split, including retired labels. Desk, history, and Camp Records Export call it. Do not re-split against the live template (ADR 0011).
- No-op correction: screen hint only. Do not add JSON-equality in SQL.
- Slip print may reuse the existing “open print window during the click” opener. Do not reuse Print prescription / `printed_at`.
- Authorization and lock-on-first-fulfilment stay in the database (ADR 0009).

---

## Testing Decisions

Good tests assert what a volunteer, patient, or operator can observe — lifecycle, presence, status text, decode outcome, refusal copy — not which helper was called.

**Prefer existing seams. Three seams, one per phase. No fourth harness.**

1. **Desk lifecycle (highest seam for Phase 1).** Existing database suite for print / mark seen / undo / status token / register idempotency, plus existing Playwright register-print and print-prescription paths. Extend those. A test that only counts RPC retries is not enough. Prove: walk-in today stays `registered` until print; print sets `printed_at` once; scan-then-sheet does not write presence twice; mark seen refuses never-printed; undo keeps `printed_at`; status token has no position; no new `waiting` writes. A skipped database test is a failure. Do not treat a missing RPC as “Postgres unavailable.”

2. **Aadhaar attempt (Phase 2).** Existing parser tests stay the depth for payload shapes. Add behaviour on the attempt seam: native text that is not a parsed card must still try the binary path; a parsed card is one outcome. Existing decode-surface tests must call the real attempt, not a reimplemented sweep. Existing fake-camera e2e remains the camp-day seam for scan → print. Do not claim the live scanner works from parser-only tests.

3. **Clinical refusals and diagnoses read (Phase 3).** Existing clinical database tests and export database tests are the seam. Prove SQL still refuses invalid save/resolve; prove stored options/Other (including retired) survive desk-equivalent read and export flatten the same way. Operator-facing Hinglish mapping is tested as “this database reason becomes this public sentence,” not by scraping the whole form. No-op correction is a screen-level behaviour; do not add a SQL equality test that the product explicitly rejected.

Do not add Playwright for Clinical Desk unless an existing role e2e already opens that station; prefer the database seam.

---

## Out of Scope

- Restoring an FCFS Queue, Live Queue panel, or public position number
- Dropping `waiting` from the Postgres enum
- A third lifecycle state for “printed”
- Merging Aadhaar decode with Patient QR decode
- eKYC, OTP, or “Aadhaar verified”
- Moving clinical writes onto Registration Staff, or Volunteer Desk actions onto the Clinical Desk Operator
- Re-splitting diagnoses against the live template
- Offline clinical PHI
- Changing who may export, or adding export audit logging (ADR 0010)
- Rate-limit compose, SMS lease merge, desk-ops wrapper collapse, camp-snapshot dual poll (Worth exploring / Speculative from the architecture review)

---

## Further Notes

- This tree has no git remote. The work order lives here under `docs/specs/`, which is this repo’s spec path. There is no GitHub issue to label `ready-for-agent`.
- ADRs 0013–0015 are already accepted and must not be re-litigated in implementation.
- Phase 1 is the product cut. Ship it behind a red-then-green database test for `printed_at` / no new `waiting` before touching Aadhaar or Clinical.
- Production is never assumed empty. Incremental migration only.
