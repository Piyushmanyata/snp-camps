# Spec: Desk-fixes review remediation

**Date:** 2026-08-10
**Branch under remediation:** `feature/2026-08-10-speed-simplicity-desk-fixes`
**Parent spec (still law):** `docs/specs/2026-08-10-speed-simplicity-desk-fixes.md`
**Origin:** dual-axis code review of `main...HEAD` (11 phase commits, 36 files)

This spec closes the review findings on the desk-fixes branch. It does **not**
re-open the parent spec's 12 accepted decisions. Where this spec amends the
parent, it says so explicitly and the amendment is the new law.

---

## Problem Statement

Eleven phases of speed-and-simplicity desk fixes were implemented and each
phase's own gate passed, but the branch cannot be merged as it stands:

1. **A volunteer would hit a half-translated screen.** The branch flipped the
   field-desk surfaces to Hinglish, but left English fragments inside the same
   panels — a volunteer opening "Aur dekhein — points, seats, team" reads
   `Loading seats…`, `Active-camp KPIs` and `Seat board` under a Hinglish
   heading. Registration staff hitting a duplicate get an English sentence in
   an otherwise Hinglish form.

2. **The project's governing rule now says the opposite of the code.**
   `CONTEXT.md` line 92 still reads "**Staff read English** — every desk, admin
   and error surface", and `AGENTS.md` line 48 repeats it. Both files rank
   `CONTEXT.md` at authority #2 and neither ranks `docs/specs/` at all, so by
   the repo's own precedence rules the shipped code is in violation of the
   documentation that outranks the spec that authorised it. The next agent to
   touch a desk surface has no way to know which document to believe.

3. **The final gate cannot have passed.** Five e2e specs still select on strings
   and controls this branch renamed or deleted — `Open camera`, `Registration
   number or name`, `Open seen registration`, `Register next`, `Household mobile
   number`. `e2e/roles.spec.ts` is broken too and was never named in the parent
   spec's list. `npm run verify` includes `test:e2e`, so the branch's "done" is
   unproven.

4. **A field-visible scanner regression shipped.** In the live decode loop the
   native-detector path marks the frame as handled whenever the camera returns
   *any* QR text, before checking whether that text was actually an Aadhaar
   payload. A patient holding a non-Aadhaar QR, or a partially-read card, now
   suppresses the WASM fallback for that frame instead of falling through to it.
   The photo path in the same file gets this right — the two disagree.

5. **A patient still sees a "Status link" heading over a message saying the
   link is not there.** The parent spec required the receipt to render *without*
   the status-link block; the block's heading survived.

6. **Panel errors stopped being recoverable.** Three independent section fetches
   in the volunteer "more" island collapse into one string with no retry, so a
   seats failure hides a leaderboard failure and neither can be retried without
   a page reload — against `CONTEXT.md`'s inline-retry-card-per-panel rule.

7. **The JS budget ratchet is not evidence.** Three routes each dropped exactly
   1000 bytes (0.24%) after moving real islands behind lazy boundaries. That is
   a hand-forced number, not a measurement.

---

## Solution

One remediation branch that makes the shipped behaviour, the governing
documents, and the test suite agree with each other:

- The language rule in `CONTEXT.md` and `AGENTS.md` is rewritten to match what
  was actually built and grilled — **patients and field staff read Hinglish;
  admin reads English** — and a standing rule is added that an accepted spec
  which changes a governing rule must amend `CONTEXT.md` in the same branch.
  This is a documentation correction, not a re-litigation.
- Every remaining English fragment on a Hinglish field surface is translated to
  a string this spec fixes verbatim.
- All six affected e2e specs are repaired and `npm run verify` is run for real,
  with the local Supabase stack up, and its output pasted into the completion
  report.
- The scanner fallback, the receipt heading, and the per-panel retry cards are
  fixed.
- The JS budgets are re-measured from a real build; whatever the formula yields
  is what lands.
- A short list of already-shipped deviations is ratified in writing so they stop
  being re-reported at every review.

---

## User Stories

1. As a volunteer at a camp desk, I want every word on my screen to be in the
   same language, so that I do not have to switch reading modes mid-task.
2. As a volunteer, I want the "Aur dekhein" panel's loading and section labels
   in Hinglish, so that the panel reads as one screen rather than two.
3. As a volunteer, I want a failed points panel to show its own retry button, so
   that I can recover without reloading and losing the queue view.
4. As a volunteer, I want a failure in the seats panel to not hide whether the
   team panel also failed, so that I know what is actually broken.
5. As registration staff, I want the duplicate-registration warning in Hinglish,
   so that I can act on it at the speed the rest of the form allows.
6. As registration staff, I want the mobile-number and Aadhaar gating copy to
   stay exactly as the accepted spec wrote it, so that training material stays
   correct.
7. As a clinical desk operator, I want lookup and save failures explained in
   Hinglish, so that an error at the desk does not need a translator.
8. As a clinical desk operator, I want a save failure announced once, not shown
   twice in two places, so that I am not unsure whether two things failed.
9. As a patient self-registering, I want the receipt to simply tell me the
   status link is available at the desk, so that I am not looking for a link
   under a heading that promises one.
10. As a patient at a camp, I want the Aadhaar scanner to keep trying when the
    first read is not a valid Aadhaar QR, so that my card scans instead of
    stalling on a bad frame.
11. As a volunteer scanning a patient who is holding the wrong QR, I want the
    scanner to fall through to the slower decoder, so that I am not forced to
    close and reopen the camera.
12. As an agent picking up work on a desk surface, I want `CONTEXT.md` to state
    the language rule that is actually in force, so that I do not "fix" correct
    Hinglish back into English.
13. As an agent, I want to know that an accepted spec cannot silently override
    `CONTEXT.md`, so that governing documents stay trustworthy.
14. As the maintainer, I want `npm run verify` to pass with the DB stack up and
    e2e running, so that "done" means something.
15. As the maintainer, I want the e2e specs to select the strings that are
    actually rendered, so that the suite catches real regressions instead of
    failing on renames.
16. As the maintainer, I want `e2e/roles.spec.ts` repaired even though the
    parent spec never listed it, so that role boundaries stay covered.
17. As the maintainer, I want JS route budgets that came from a measurement, so
    that the ratchet keeps meaning something.
18. As the maintainer, I want the already-shipped deviations ratified in the
    spec record, so that the next review does not re-raise them as findings.
19. As the maintainer, I want the duplicated toast-error wiring collapsed into
    one helper, so that a future change to error handling happens in one place.
20. As the maintainer, I want dead props and unused re-export hops removed, so
    that the next reader does not trace an indirection to nothing.
21. As a reviewer, I want each fix traceable to the finding it closes, so that I
    can confirm coverage without re-deriving the review.

---

## Implementation Decisions

Ordered by risk. One commit per phase, message `review-fix 2026-08-10 phase N:
<title>`. Do not reorder. Phases A and C are blockers; the rest may not be
skipped but may be committed in any order after A.

### Phase A — Reconcile the governing language rule (blocker)

The parent spec's Hinglish decision is accepted and grilled; the documents are
what is wrong. Amend both, do not revert code.

1. `CONTEXT.md` §Language — replace the two bullets at lines 91–92 with:
   - `**Patients and field staff read Hinglish** — the self-registration flow,
     the status page, SMS, the public home page, and every field desk surface:
     register, volunteer desk, clinical desk, queue, scanner, print actions.`
   - `**Admin reads English** — `/admin/**`, staff management, exports, and
     every admin-facing banner.`
   - `Mixing the two inside one surface is a bug. Where a string's meaning would
     have to be guessed, keep it English rather than invent Hinglish.`
2. `AGENTS.md` line 48 — replace `Patients read Hinglish; staff read English.
   Leaks in either direction are bugs.` with a one-line form of the same rule:
   `Patients and field staff read Hinglish; admin reads English. Mixing the two
   inside one surface is a bug.`
3. Add to the **Document Authority Precedence** section of *both* files, as a
   closing line: `A spec under docs/specs/ is a work order, not a governing
   document. An accepted spec that changes a rule in this list must amend that
   document in the same branch — an unamended conflict resolves against the
   spec.`

**Rejected alternative:** reverting the field surfaces to English. The Hinglish
decision was made deliberately for volunteer-operated desks and is one of the
parent spec's twelve accepted decisions; reverting it would undo the point of
the branch.

### Phase B — Close the Hinglish/English leaks

Verbatim strings. The parent spec's "if a string's meaning is unclear, KEEP THE
ENGLISH" escape applies only to strings whose meaning is genuinely ambiguous —
none of the strings below qualify, and each has a fixed translation here.

1. `src/components/volunteer-desk-more.tsx`:
   - `Loading team…` → `Team load ho rahi hai…`
   - `Loading seats…` → `Seats load ho rahi hain…`
   - `Loading points…` → `Points load ho rahe hain…`
   - `Active-camp KPIs` → `Aaj ke camp ke numbers`
   - `title="Seat board"` → **unchanged.** "Seat board" is `CONTEXT.md`
     ubiquitous language, in the same protected class as Print / QR / Aadhaar /
     Team Lead / Camp.
2. `src/app/volunteer/page.tsx`:
   - `Active camp` → `Chalu camp`; `None` → `Koi nahi`
   - `noCampReason` → `Koi active camp nahi. Admin se camp chalu karwayein.`
     (already the parent spec's verbatim disabled-state copy — reuse it, do not
     write a second variant)
3. `src/components/patient-form.tsx` duplicate error → `Yeh naam aur Aadhaar ke
   aakhri 4 digit registration #{n} ke hain.` (keep the interpolated number in
   the same position)
4. `src/components/clinical-desk.tsx`:
   - `Exact registration lookup failed.` → `Registration lookup fail ho gaya.
     Dobara koshish karein.`
   - `Follow-up lookup failed.` → `Follow-up lookup fail ho gaya. Dobara koshish
     karein.`
   - `Slip could not be replaced. Try again.` → `Slip badal nahi payi. Dobara
     koshish karein.`
   - `Could not record this outcome. Try again.` → `Faisla save nahi hua. Dobara
     koshish karein.`
   - hint `Free text — not split on commas` → `Free text — commas se alag nahi
     hoga`

Do not translate `data-testid` values, ARIA role names, or RPC parameter values.

### Phase C — Repair the e2e suite and run the real gate (blocker)

Six files, not the five the parent spec listed. Update selectors to the strings
now rendered; do not weaken an assertion into a substring match to make it pass,
and do not delete a test.

1. `e2e/island-split.spec.ts` — `Open camera` → `Camera kholein` (lines ~115,
   154, 165, 169, 170, 179, 227); `Registration number or name` → `Registration
   number ya naam` (~158). Update the expected island lists for Phase 6's lazy
   moves and the deleted `patient-qr-camera`.
2. `e2e/a11y-computed.spec.ts` — same two renames (~437, 442, 472, 502, 505,
   513, 518, 542, 544, 546, 551, 709). The `Register next` link (~693) and the
   `Open seen registration` button (~816) no longer exist: delete those
   assertions and their surrounding setup, and in the same commit confirm the
   remaining exit control on that surface still passes the touch-target and
   focus-visible checks.
3. `e2e/register-print.spec.ts` — `Household mobile number` → `Ghar ka mobile
   number` (~120, 148).
4. `e2e/roles.spec.ts` — `Registration number or name` → `Registration number ya
   naam` (~170, 189, 291, 317, 329). **Not in the parent spec's list; it is in
   scope here.**
5. `e2e/desk-action-timing.spec.ts` — renamed strings only.
6. `e2e/print-prescription.spec.ts` — must pass **unchanged**. If the
   scale-to-fit wrapper broke a selector, fix the wrapper, not the assertion.

Then run the real final gate: `npx supabase start`, then `npm run verify`. A DB
suite that reports "Postgres unavailable" and skips is **not** a pass — the
suites self-silence, so confirm they actually executed.

### Phase D — Scanner native-path fallback

In `src/components/use-aadhaar-scanner.ts`, the live loop (~lines 348–370) must
gate on the decode *outcome*, not on the presence of raw text: set the
`handledNative` flag only when the decoded outcome is something other than
`none`, matching what the photo path already does at ~478 and ~508. When the
native detector returns text that does not resolve to an Aadhaar payload, the
frame must fall through to `client.decodeFrame`.

Do not touch probe geometry, the escalation schedule, or the `MAX_DECODE_EDGE`
cap — ADR 0012 defers that re-tune, and bounding the cap has regressed twice.

### Phase E — Receipt status-link block

In `src/components/self-registration-receipt.tsx`, when `statusUrl` is `null`
the `Status link` heading must not render — the receipt shows only `Status link
desk par milega.` in that block's place. When `statusUrl` is present, the block
renders as it does today, heading included.

### Phase F — Per-panel retry in the volunteer "more" island

In `src/components/volunteer-desk-more.tsx`, replace the single merged `error`
string (the `setError((prev) => prev ?? boardRes.error)` collapse) with one
error slot per section — seats, KPIs, leaderboard — each rendering its own
inline retry card inside its own panel, per `CONTEXT.md` §Navigation. Retry
re-fetches only that section. Card copy: `Ye hissa load nahi hua.` with button
`Dobara koshish karein`.

### Phase G — Single error channel on the clinical desk

The parent spec said "Remove the standalone `<ErrorBox message={error} />`" and
route errors to toasts. `clinical-desk.tsx` instead swapped in a visually
identical inline red `<p role="alert">` in the same position, so a failure now
appears twice.

1. `clinical-desk.tsx` — remove the inline red `<p role="alert">` block; the
   toast is the error channel. Keep an `sr-only` `role="alert"` node carrying
   the same message so screen readers still get it.
2. `patient-form.tsx` — **no change.** Its `sr-only` alert plus toast is what
   the parent spec intended, and the amber `role="alert"` block is the
   likely-duplicate soft warn, which is an in-flow decision prompt with two
   actions, not an error display.
3. Collapse the copied error-toast wiring into one helper used by
   `clinical-desk.tsx`, `live-queue.tsx`, `qr-scanner.tsx` and `patient-form.tsx`:
   a `useToastedError()` hook returning `[error, setError]` where setting a
   non-null value also fires `showErrorToast`. Four call sites, two conventions,
   one behaviour today.

### Phase H — Copy and dead-code cleanup

1. `src/components/print-actions.tsx` — restore the distinct empty-sheet
   message: `Is sheet par koi marij nahi.` It was collapsed into the generic
   failure string and its meaning was lost.
2. `print-actions.tsx` — delete the dead `deskLabel` prop (currently renamed to
   `_deskLabel` and unused) and remove it from all callers.
3. `print-actions.tsx` — the new string `Print taiyaar…` is **ratified**; keep
   it.
4. `print-actions.tsx` — replace the two back-to-back `primaryStatus` ternary
   cascades (`printLabel`, `heading`) with one status-keyed record both read
   from.
5. `clinical-desk.tsx` — hoist the thrice-repeated literal `Pehle record save
   karein, phir faisla likhein.` to one constant used by `RESOLVE_ERRORS`, the
   `resolve()` guard, and the `!hasTranscription` hint.
6. `clinical-desk.tsx` — fold the post-hoc `if (matched && /date and
   venue/i.test(rpcMessage))` special case into the `RESOLVE_ERRORS` table
   itself; the table should yield the final message with no override after it.
7. Remove the two re-export hops: the bare `export { formatClinicalRecordRows }`
   pass-through in `clinical-record-view.tsx`, and `OpenOnToggle`'s re-export
   from `ui.tsx`. Callers import from the owning module. `OpenOnToggle` stays in
   `src/components/open-on-toggle.tsx` — hooks in shared `ui.tsx` broke the RSC
   build, and that extraction is **ratified**.
8. `src/components/desk-scan-queue.tsx` — the four optional string props
   (`scanTitle`, `scanHint`, `queueTitle`, `queueHint`) have exactly one
   overriding caller and English defaults that can never render under the Phase
   A rule. Make the Hinglish strings the component's own copy and delete the
   four props and the caller's overrides.

### Phase I — Re-measure the JS budgets

Delete the forced −1000 adjustments. Run a real production build, take the
measured gzipped eager-initial size per route, and set each budget to
`min(old, ceil(gzip * 1.03 / 1000) * 1000)` — the file's own documented formula,
with no manual nudge. Paste the measured numbers into the completion report
alongside the resulting budgets.

If a route's formula value lands at or above its current budget, **leave that
budget unchanged and say so**. Never raise a budget. A route that did not drop
is a finding to report, not a number to force.

### Ratified deviations (close as accepted, change nothing)

These were reported by the review and are hereby accepted into the parent spec's
record. They are not defects and must not be re-raised:

- **`OpenOnToggle` lives in its own module** rather than `ui.tsx`; `ui.tsx` had
  to stay hook-free for RSC.
- **`staff-leaderboard` section key + `isStaff` guard** added to the desk
  section route. The lazy island needs a section key to fetch through, and the
  role guard is required by the least-privilege rule.
- **`src/lib/clinical-record-format.ts` split out** from
  `clinical-record-view.tsx`; a pure formatter separated from a view is the
  better shape and made the required unit test possible.
- **`normalizeDiagnoses` called without a template for legacy arrays** — the
  literal spec call was not expressible; intent is preserved.
- **Volunteer desk deletions** beyond the parent spec's four numbered items (the
  `#scan`/`#queue` jump chips, the desktop inline `Register` NavLink, the
  zero-value `Stat` fallback grid, and the "these numbers stay at zero" note) —
  all follow from the simplification the phase ordered.
- **`#{reg_no}` prefix on the live-queue undo toast.** The parent spec's
  verbatim was `Wapas line mein aa gaya`, but the two sibling toasts in the same
  list are specified *with* the prefix (`#N dekha hua ho gaya`, `#N pehle se
  dekha hua tha`). The prefix is the consistent form and identifies the row.
  **Amends the parent spec's copy list; keep the code as shipped.**

---

## Testing Decisions

A good test here asserts what a volunteer or patient can observe — rendered
text, a control's presence, a network call — not how a component stores state.
The repo already has the right seam for that, and this spec adds no new one.

**Primary seam: the existing Playwright specs under `e2e/`.** This is the
highest seam in the codebase and the one the branch broke. Every user-visible
fix in this spec is pinned there:

- Phase B leak fixes → assert the Hinglish strings in the volunteer "more"
  panel and on the register form, in `island-split.spec.ts` and
  `register-print.spec.ts`.
- Phase E receipt → assert `Status link desk par milega.` is present and the
  `Status link` heading is absent when there is no token.
- Phase F per-panel retry → force one section fetch to fail and assert the other
  panels still render, and that the failed panel shows its own retry control.
- Phase G single error channel → assert a clinical-desk failure produces exactly
  one visible error surface.
- Phases C, H → the repaired selectors are themselves the assertion.

**Scanner (Phase D): the existing fake-camera harness** wired through
`e2e/fake-aadhaar-camera.mjs` and `e2e/run-local.mjs`. Unit tests on this hook
have passed while the live scanner stayed broken — an outcome-level unit
assertion is not acceptable evidence for this fix. Drive a non-Aadhaar QR into
the fake camera and assert the WASM fallback still runs for that frame.

**Node `tests/*.mjs` (`node:test`, route-loader stubs) only for pure functions**
already covered there — `toast-bus.test.mjs`, `clinical-record-view.test.mjs`.
Prior art for style is the existing files in `tests/`.

**Fix the brittle assertion, do not extend it.**
`tests/camp-desk-live-wiring.test.mjs` was edited to chase a rename with
`assert.match(scanner, /Parchi print karein/)`. `AGENTS.md` §Testing names this
exact failure mode. Replace the source-text regex with a behavioural assertion,
or move the coverage to the e2e seam and delete the regex.

**Must pass untouched:** `tests/qr-decode-surface.test.mjs` (Phase 8 guard) and
`e2e/print-prescription.spec.ts` (print geometry).

**Rejected seams.** A copy-contract unit test asserting every verbatim Hinglish
string appears in source was considered and rejected: it is precisely the
brittle source-text assertion `AGENTS.md` discourages. Extracting a shared
`desk-copy` string module was also rejected — it is a seven-component refactor
on a branch already carrying scope-creep findings.

**Final gate:** `npx supabase start`, then `npm run verify`. Paste the real
output. A skipped DB suite is not a pass.

---

## Out of Scope

- Re-opening any of the parent spec's twelve accepted decisions, including the
  decision that field desks read Hinglish.
- The deep live-scanner pipeline re-tune against the empirical harness, probe
  geometry, the escalation schedule, and `MAX_DECODE_EDGE` (ADR 0012 defers it).
- Any change under `supabase/**` — no SQL, RLS, RPC, or migration work.
- `qr-decode-geometry.ts` and `aadhaar-decode.worker.ts`.
- Printed A4 geometry, `@page` rules, letterhead.
- Admin layouts and admin-facing English copy.
- Raising any JS route budget, under any justification.
- Devanagari script UI; admin-surface Hinglish.
- The unrelated working-tree WIP on this branch: `CONTEXT.md` clinical edits,
  `src/lib/readiness-contract.ts`, `tests/status-queue-position.db.test.mjs`,
  `tests/team-membership.db.test.mjs`, the untracked migrations, and
  `.wip-stash/`. Phase A edits `CONTEXT.md`'s Language section only and must not
  absorb the existing local modifications into its commit.
- Pushing the branch or opening a PR — that needs the maintainer's word.

---

## Further Notes

### Do not

- Do not revert the Hinglish field-desk copy to English "to satisfy
  `CONTEXT.md`". `CONTEXT.md` is what changes.
- Do not translate `data-testid` values, ARIA role names, or RPC parameter
  values while translating visible copy.
- Do not weaken an e2e assertion to a substring or regex match to make a renamed
  selector pass; update it to the exact rendered string.
- Do not delete a failing test to make a phase green.
- Do not re-raise the ratified deviations listed above.
- Do not force a JS budget number; if a route did not drop, report it.
- Do not commit the unrelated working-tree WIP.
- Do not re-run Grill Me.

### Definition of done

- [ ] Phases A–I committed, one commit each, `review-fix 2026-08-10 phase N:` prefix.
- [ ] `CONTEXT.md` and `AGENTS.md` state the language rule the code implements,
      plus the spec-must-amend-governing-docs line.
- [ ] No English fragment remains on a Hinglish field surface, and no Hinglish
      on an admin surface.
- [ ] All six e2e specs pass; `print-prescription.spec.ts` and
      `qr-decode-surface.test.mjs` passed without edits.
- [ ] `npm run verify` run with the Supabase stack up, output pasted, DB suites
      confirmed executed rather than skipped.
- [ ] JS budgets carry measured numbers with the measurements recorded.
- [ ] Each of the review's findings maps to a phase, a ratification, or a stated
      reason for no action.

### Traceability

| Review finding | Phase |
|---|---|
| Standards 1 — language rule unamended | A |
| Standards 2 — bidirectional language leaks | B |
| Standards 3 — merged panel errors, no retry | F |
| Standards 4 — brittle source-text assertion | Testing Decisions |
| Standards — duplicated toast-error setter | G.3 |
| Standards — repeated literal, repeated switch, middle man, data clump, dead prop, post-hoc override | H |
| Spec 1 — e2e specs untouched, verify unproven | C |
| Spec 2 — `ErrorBox` not actually removed | G |
| Spec 3 — budget ratchet unmeasured | I |
| Spec 4 — native path suppresses WASM fallback | D |
| Spec 5 — live-queue toast copy drift | Ratified |
| Spec 6 — receipt keeps "Status link" heading | E |
| Spec 7 — `normalizeDiagnoses` deviation | Ratified |
| Spec 8 — print-actions copy, dead prop, new string | H.1–H.3 |
| Spec 9 — `staff-leaderboard` server surface | Ratified |
| Spec 10 — unlisted volunteer deletions | Ratified |
| Spec 11 — extra `clinical-record-format.ts` | Ratified |
