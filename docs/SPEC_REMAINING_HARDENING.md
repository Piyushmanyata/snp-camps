# Spec — Remaining hardening and delivery discipline for SNP Camps

**Status:** ready-for-agent
**Date:** 2026-07-25
**Derived from:** review of GitHub issues #1–#35 and the code on `main` at `92d0882`
**Domain vocabulary:** see `CONTEXT.md` (Camp, Camp Day, Patient, Staff, Camp crew, Patient QR, FCFS Queue, Volunteer Desk, Doctor Station, Desk Slip, Passcode, Seen)
**ADRs that constrain this spec:** `docs/adr/0001-passcode-on-desk-slip.md`

---

## Problem Statement

Thirty-five tickets have been worked. Fifteen closed. The product on `main` is materially better than it was: public self-registration works again, the test suite no longer lies, patient login requires a secret the patient actually holds, the production CSP constrains script execution, and "Staff" no longer silently means two different things on two sides of the wire.

But the operator cannot currently answer three basic questions with confidence.

**1. Is `main` shippable right now?** No. `npm run verify` is red. The lint step fails on the desk-slip print component introduced by the passcode work (#15) — `react-hooks/set-state-in-effect`. Because `verify` runs lint first and short-circuits, the whole gate has been red since that commit landed, and every ticket closed after it reported evidence that never included lint or build. The last time anyone ran the full gate was five feature commits ago.

**2. Does the database in production match the migrations in the repo?** Unknown, and the repo actively encourages the wrong answer. Two migration files exist. Neither has been applied to production; production got its schema from a bespoke runner that was deleted in #9. `supabase migration repair` was never run, so the remote ledger has no record of either file. The next person who follows the README and runs `npx supabase db push` against the linked project will attempt to replay a 2,190-line baseline onto a live database with real camp data. Separately, the baseline file was hand-edited after it was generated (#10 appended the `is_camp_crew()` split into it), so it no longer represents a dump of anything — not production, not any point in history.

**3. Will the test suite catch the next regression?** Partly. The behavioural core is genuinely good. But `tests/security-invariants.test.mjs` — introduced in #8 as a narrow, deliberate exception for lint-shaped invariants that grep is the right tool for — has grown from three tests to seven, and the four added since are ordinary source-text tests wearing the exception's badge. One of them asserts on the exact whitespace of a `return NextResponse.json({ ok: true, regNo,` expression. A Prettier run breaks it; a behavioural regression does not. This is the precise category #8 deleted 2,180 lines to eliminate, regrowing inside the file that was supposed to be its only sanctioned home.

Underneath those three, a fourth problem shapes all the remaining work. **Nineteen tickets are open, and most of them ask the executor to decide something rather than to build something.** #18 says "decide the intended behaviour (most likely: return the candidates and let the person choose)". #21 says "decide whether that trade-off is intended and document it". #32 says "that may be correct, but it should be a decision rather than an accident". #33 says "settle the differences in whichever direction is right — the spec is not automatically correct". Each of those is a product decision handed to an agent that has no product authority and no way to ask. The result is either a stalled ticket or an agent quietly inventing a product rule.

## Solution

Three things, in order.

**First, make the gate green and keep it green.** Fix the lint error, run the full `verify` plus the Playwright role suite, and establish one non-negotiable rule for every ticket that follows: a ticket is not closed until `npm run verify` and `npm run test:e2e` have both been run and their real output pasted into the closing comment. "`npm test` 32/32 + `tsc --noEmit` clean" is not the gate and never was.

**Second, reconcile the migration ledger with production before anyone touches the database again.** Regenerate the baseline so it is once again a faithful dump, register both existing migrations in the remote ledger with `migration repair` so `db push` becomes safe, and prove the round trip on a disposable project rather than on the camp's live data.

**Third, convert every remaining open ticket from a question into an instruction.** Every product decision the tickets currently defer is made here, in this spec, explicitly. The executor agent's job becomes implementation and verification — never adjudication. Where a decision genuinely needs the operator, it is called out as a blocking question in this document rather than buried as a parenthetical inside a ticket an agent will pick up at 3am.

The recurring failure across the closed tickets was not skill. Every root cause named in #7, #8, #9, #10, #15 was correct, and several were subtle. The failure was that **work was consistently declared done one step before the step that proves it** — the #7 regression test placed in a file queued for deletion, the #8 pass count reported without the coverage lost, the #9 plan written without the risk-free `supabase init` that preceded it, the #13 CSP shipped without a browser ever loading a page under it, the #15 passcode flow closed without lint. Each individual gap was small. Together they are why the gate is red and nobody noticed.

## User Stories

### Shipping confidence

1. As an operator, I want `npm run verify` to pass on `main`, so that I know the branch I am about to deploy actually builds and lints.
2. As an operator, I want every closed ticket's evidence to include real `verify` and e2e output, so that "done" means the same thing in every ticket.
3. As an operator, I want the Playwright role suite run after any change to auth, roles, or the desk slip, so that a rewrite of the login path cannot ship unexercised.
4. As an operator, I want a single command that tells me whether the branch is shippable, so that I do not have to reconstruct the answer from ticket comments.
5. As a reviewer, I want a closing comment to state what coverage was *removed* as well as what passes, so that a rising pass count cannot disguise a falling coverage surface.

### Database and deployment safety

6. As an operator, I want the migration ledger in the repo to agree with the ledger in production, so that `supabase db push` is a safe command rather than a loaded one.
7. As an operator, I want the baseline migration to be a faithful dump of a real schema state, so that reading it tells me what the database actually contains.
8. As a developer, I want incremental schema changes to go in their own migration files and never be edited into the baseline, so that history stays readable.
9. As a developer, I want a documented, rehearsed procedure for applying a schema change to production, so that the first time I run it is not on camp day.
10. As an operator, I want to know, for every migration file in the repo, whether it has been applied to production, so that drift is visible rather than inferred.

### Test suite integrity

11. As a developer, I want the security-invariant suite to contain only invariants that no behavioural test could express, so that the exception does not become the rule.
12. As a developer, I want no test to assert on source whitespace or formatting, so that a formatter run cannot turn the build red.
13. As a developer, I want behaviour that can be tested behaviourally to be tested behaviourally, so that a green suite means the product works.
14. As a developer, I want logic that lives inside a large component extracted into a pure module before it is tested, so that coverage does not require a new test framework.
15. As a developer, I want a deliberately-broken run (remove the fix, watch it go red) recorded for every regression test, so that I know the test can actually fail.

### Patient authentication and accounts

16. As a patient who registered before the passcode scheme existed, I want a working way back into my profile, so that I am not locked out by an upgrade I never saw.
17. As a member of staff, I want to reissue a passcode for any patient whose account predates the passcode scheme, so that a lost or nonexistent slip is a thirty-second fix at the desk.
18. As a security reviewer, I want no account left holding a password that was ever a shared constant, so that the old enumeration attack has no residue.
19. As a member of staff, I want patient account provisioning to be one comprehensible operation, so that a failure mid-flow leaves the patient either fully provisioned or untouched — never half-linked.
20. As a member of staff, I want to retry a failed provisioning without fear, so that a flaky camp network does not create duplicate or orphaned accounts.
21. As a doctor, I want to be unable to reset a patient's login, so that credential authority stays with the desk.

### Registration and the queue

22. As a patient retrying a submission after the network dropped, I want the retry to return my original registration number, so that I do not end up registered twice or permanently blocked.
23. As a member of staff, I want a registration retry to work even for a patient with no camp day set, so that the idempotency key protects the case it exists for.
24. As an operator, I want the camp-day seat limit to remain impossible to exceed under concurrent registration, so that overbooking stays impossible.
25. As a household sharing one phone, I want each member to be able to link their own patient record, so that a relative registering later does not make me unreachable.
26. As a member of staff linking by phone, I want to be shown the matching patients and asked which one, so that the system never guesses on my behalf.
27. As a member of staff, I want the print action's effect on the queue to be predictable and documented, so that a cancelled print dialog does not silently change a patient's queue status.

### Live queue and staff screens

28. As a volunteer, I want the queue on my screen to reflect a patient being marked seen within about a second, so that I do not call someone a doctor has already finished with.
29. As a doctor, I want my station to update without a manual refresh, so that my hands stay on the patient rather than the tablet.
30. As a member of camp crew on a dropped connection, I want the screen to fall back to periodic refresh and tell me it has, so that I know whether what I am looking at is live.
31. As a patient, I want my own status screen to keep behaving exactly as it does today, so that this change carries no risk to the patient-facing path.
32. As an operator, I want the seat board and the queue to refresh by the same rule, so that two numbers on one screen cannot be from different moments.

### Errors, empties and offline

33. As a volunteer, I want a failed data load to look like a failure, so that I do not mistake a database outage for a quiet morning.
34. As an admin, I want an error message written for a camp worker, so that I am never shown raw Postgres constraint text.
35. As a volunteer whose doctor list failed to load, I want to be told it failed, so that I do not conclude the admin forgot to add doctors.
36. As a member of camp crew, I want a retry button on anything that failed because of the network, so that recovering does not mean re-entering the form.
37. As a member of camp crew, I want an operation that cannot be safely retried to say so, so that I do not create a duplicate by tapping twice.

### Accessibility and interface

38. As a keyboard user, I want the password dialog to trap focus, close on Escape, and return focus where it came from, so that I am not stranded behind a modal.
39. As a screen-reader user, I want the queue count to be announced only when it changes, so that I am not interrupted every two minutes with the same number.
40. As a keyboard user, I want every scrollable list to be reachable and scrollable without a mouse, so that the desk works from a keyboard.
41. As a member of staff picking a doctor, I want a control that behaves like a single choice, so that the interface matches what the action actually is.
42. As a screen-reader user, I want collapsible section titles in the document outline, so that I can navigate a dense admin page by heading.
43. As a low-vision user in bright outdoor light, I want text and status badges that meet AA contrast, so that the desk is readable in a hall with open doors.
44. As a member of staff, I want a printed desk slip whose QR always uses the compact payload, so that paper codes scan first time.

### Codebase shape

45. As a developer, I want staff management written once and parametrised by role, so that a fix to the volunteer path cannot forget the doctor path.
46. As a developer, I want the scanner split along the seams it already has implicitly, so that its camera teardown logic can be reasoned about alone.
47. As a developer, I want the registration form's state in one reducer, so that its two submit paths do not diverge again.
48. As a developer, I want one explicit convention for reconciling optimistic edits against fresh server data, so that three components do not each invent one.
49. As a developer, I want no server module importing a type from a client component, so that the dependency direction is honest.
50. As a developer, I want deprecated caching APIs off the codebase, so that a framework upgrade is not a rewrite.

### Documentation truth

51. As a new developer, I want the README's camp flow to describe the auth scheme that actually ships, so that my first mental model is not three tickets out of date.
52. As an operator, I want `CONTEXT.md`, the ADRs and the README to agree, so that I do not have to guess which one was updated last.
53. As a developer, I want every open ticket to name its decisions rather than ask me to make them, so that I can start work without a product conversation.

## Implementation Decisions

Everything below is **decided**. Executor agents implement it as written. Where an alternative was considered and rejected, the reason is given so the decision is not silently re-litigated.

### D1 — The definition of "done"

A ticket is closed only when its closing comment contains:

- The literal terminal output of `npm run verify` (lint, then unit tests, then production build — all three, in one run).
- The literal terminal output of `npm run test:e2e`, or a named, specific environment blocker (missing credential, no Docker daemon) — never "not run this session".
- An explicit statement of coverage **removed** by the change, if any, or "no coverage removed".
- For a bug fix: proof the new test can fail. Remove the fix, record the red output, restore it, record the green output. Both go in the comment.

`npm test` alone and `tsc --noEmit` alone are diagnostics, not gates. Reporting them as closing evidence is what let a lint error sit on `main` across five commits.

**Rejected:** relaxing this for "trivial" tickets. #11 was trivial and correctly closed; the discipline costs a minute and the alternative is the current state.

### D2 — Fix the lint failure by removing the effect, not by disabling the rule

The desk-slip print component reads the passcode out of `sessionStorage` in an effect and immediately calls `setState`. The rule flagging it is correct: this is a render-time read of an external store, not a synchronization.

**Decision:** read the passcode through React's external-store subscription primitive (`useSyncExternalStore`) with a server snapshot of `null`, so the server render and the first client render agree and no cascading render occurs. Do not add an eslint-disable comment. Do not move the read to a parent and pass it down as a prop — the parent is a Server Component and `sessionStorage` does not exist there.

The passcode must continue to come from `sessionStorage` and never from a URL parameter, per ADR 0001 §3.

### D3 — Migration ledger reconciliation, in this exact order

1. Verify current remote ledger state with `supabase migration list` against the linked project. Record the output. Expect both local files to show as *not applied remotely*.
2. Regenerate the baseline as a true dump of the current production schema (`supabase db dump`), replacing the hand-edited file. The regenerated dump **will** contain `is_camp_crew()` only if the split was applied to production; if it does not, that is the honest answer and the split migration stays as a genuinely pending change.
3. Register the baseline as already-applied in the remote ledger via `supabase migration repair --status applied <baseline-version>`. This writes a ledger row; it does **not** execute the SQL.
4. For each remaining migration, decide from the dump in step 2 whether it is already present in production. Repair as `applied` if present; leave pending if not.
5. Prove the whole ledger from empty: `supabase db reset` against a local or disposable remote project, confirming the baseline plus pending migrations reproduce the schema. Record the output.
6. Only then apply any genuinely pending migration to production, and only with explicit human sign-off recorded in the ticket.

**Standing rule from this point:** the baseline file is append-never. Every schema change gets its own `supabase migration new` file. Editing the baseline in place — as #10 did — destroys its meaning as a dump and is prohibited.

**Rejected:** dropping and recreating the production schema from the baseline. There is patient data in the live project and the camp is operational.

### D4 — The security-invariant exception has hard boundaries

`tests/security-invariants.test.mjs` may contain only assertions meeting **all** of these:

- The property is about a file's *existence, imports, or absence of a token* — not about the shape of an expression.
- There is no behavioural way to express it. "This secret never reaches the client bundle" qualifies. "This endpoint does not return a password" does not — that is a response body, which is behaviour.
- The regex matches an identifier or an import, never punctuation, whitespace, or argument layout.

By that rule, the three original tests stay (service-role absent from client code, admin module is `server-only`, RLS enabled on every public table in the baseline). The four added since are removed from this file and re-expressed as behaviour:

- **Patient login returns no credentials** → call the route handler with a mocked Supabase client; assert the response body for a successful login contains exactly `ok` and `regNo`, and that a failed login returns the same status and message for a wrong reg number as for a wrong passcode.
- **Health readiness is rate-limited** → call the route handler thirteen times; assert the thirteenth returns 429. Assert the liveness path is never rate-limited.
- **Production CSP has no `unsafe-inline`** → already behavioural where it calls `buildContentSecurityPolicy`; keep that half, delete the halves that grep `next.config.ts` and `src/proxy.ts`.
- **Staff vs Camp crew alignment** → the TypeScript half is already covered by unit tests on the predicates. Keep only a single SQL-side assertion that the two functions list the role sets `CONTEXT.md` says they do, since SQL function bodies have no other seam.

**Rejected:** deleting the file entirely. The three original invariants are real and have no other home.

### D5 — Legacy patient accounts (closes the last live part of #16)

The credential-returning login endpoint is already gone: `/api/patient-login` now requires a passcode, holds no service-role client, mints nothing, and the shared default constant is absent from the codebase. What remains is the population of accounts provisioned under the old shared password.

**Decision:** do not attempt an automated password rotation. Instead:

- Add a staff-visible marker on the patient desk for any patient whose Auth account has never had a passcode issued under the new scheme. Derive it from a nullable `passcode_issued_at` timestamp on the patient row, set by the issue/reissue path. Null means "legacy — reissue before this patient can log in".
- Staff reissue via the existing Issue/Reissue control. No new flow.
- Rewrite #16 to reflect this. Its first three acceptance criteria are already satisfied and should be marked so with evidence rather than left open, which currently makes the ticket look untouched.

**Rejected:** force-rotating every legacy account to a random passcode in a script. That locks out every such patient with no slip to recover from, which is worse than the status quo.

### D6 — Patient account provisioning (#17)

The two-phase ladder exists because Auth user creation and the patient-row link are separate systems. Under passcode auth the ordering can be inverted so no compensation is needed.

**Decision:** provision in this order — create the Auth user first, keyed on the deterministic synthetic email `reg{N}@patients.snp.local`; then link the patient row with a conditional update that only succeeds when `user_id` is still null.

- If the Auth user already exists, that is a **success**, not an error. The email is deterministic, so an existing user for this reg number *is* this patient's account. Treat "already registered" as "found" and continue to the link step. This removes the entire `already|registered|exists` branch and its rollback.
- If the link update matches zero rows, another request won the race. Return the existing linkage; do not delete the Auth user. Deleting it is what makes the current code destructive under concurrency.
- Drop the `account_provisioning_token` column and every read and write of it. The conditional update on `user_id is null` is the concurrency control; a second lock column adds nothing.
- Passcode issue and reissue is a separate operation from provisioning: set the Auth password, stamp `passcode_issued_at`, return the plaintext once to the authenticated staff caller. It is idempotent by construction because it always sets a fresh value.
- Authorization stays `isStaff` (admin, volunteer). Doctors are camp crew, not staff, and must not reach either operation.

Retry safety is the acceptance test: calling provision twice with the same patient must produce one Auth user, one link, and two successful responses.

### D7 — Shared family phone numbers (#18)

**Decision: return the candidates; never guess.**

`link_patient_phone` returns the set of unlinked patients matching the normalised phone. Zero matches is an error as today. One match links immediately, unchanged. Two or more returns the candidate list — registration number, full name, camp day — and links nothing until a second call names a specific patient id.

The caller of the multi-match path is a member of staff at the desk with the patient physically present, so a disambiguation prompt is cheap and correct. A patient self-registering by OTP who hits a multi-match is shown the same list; the phone owner can identify their own record.

`CONTEXT.md` gains: *a phone number identifies a household, not a patient; a patient is identified by registration number*.

**Rejected:** binding the most recent registration, which is today's silent behaviour and the reason older family members become unreachable.

### D8 — Idempotency replay (#19)

Change the replay lookup to a left join on camp days so a patient with a null camp day is still found by request id. Keep the seat-limit row lock exactly as it is — it is correct and serialises properly.

Drop `register_patient()`. It generates a fresh request id per call, so it is not idempotent, and it returns an always-null claim-token column left over from the removed scheme. Confirm no caller remains before dropping.

The concurrency test is not optional: N concurrent registrations against a camp day with M seats, where N > M, must produce exactly M successes.

### D9 — Volunteer KPIs (#20)

**Decision:** keep `staff_person_kpis`, delete `volunteer_my_counts`, and point the volunteer desk at the survivor. `staff_person_kpis` already serves both the admin staff panel and the doctor case, and it scopes to an explicit camp, which is the behaviour that is defensible.

With no active camp, KPIs return **zero across every metric**, not an all-time total. A volunteer desk with no camp active is not a report of career totals; showing one is the bug that made the two functions visibly disagree. Document this in `CONTEXT.md`.

### D10 — Schema consistency (#21)

- Every `SECURITY DEFINER` function uses `SET search_path TO 'pg_catalog', 'public'`. Bring the eight outliers into line.
- Delete the no-op branch in `delete_camp` and the variable computed only to feed it.
- Fix the mojibake in the `delete_camp_day` message; use a plain ASCII hyphen rather than an em dash so encoding cannot bite again.
- Add a composite index supporting the admin patient desk's ordering, scoped by camp. Attach the `EXPLAIN` plan before and after to the ticket.
- **Decision on the Aadhaar duplicate index:** keep it, and make its failure recoverable rather than fatal. Two people sharing a common name and the same last four Aadhaar digits is rare but real; refusing the registration outright is unacceptable at a desk. On conflict, surface a message that names the conflicting registration number and offers staff an explicit override that records who overrode it. Document the trade-off in `CONTEXT.md`.

### D11 — Retire `app_database_contract` (#22)

Delete the function and its caller in the readiness endpoint. Readiness keeps the table-shape probes and the phone-OTP check, and adds the migration ledger's latest applied version as a reported field. Blocked on D3 — the ledger has to be trustworthy before anything reads it.

### D12 — Merge staff management (#23)

One route handler and one component, parametrised by role. The two routes are byte-identical after substituting the role string, apart from three `revalidateTag` calls present in the doctors route and absent from the volunteers route — which is the exact class of divergence duplication produces.

**Decision:** the merged implementation invalidates the cache tag for **both** roles on every mutation. Preserve the self-deactivation guard. Cache invalidation on doctor changes must still work end-to-end, verified by mutating a doctor and observing the volunteer desk's doctor list update without a hard reload.

### D13 — Doctor list (#24)

Delete the non-service-role fallback path entirely. It queries `profiles` under the caller's session, where RLS returns an empty set for a volunteer with **no error** — indistinguishable from "no doctors exist". A configuration where the service-role key is absent is a broken deployment, not a supported mode.

**Decision:** when the service-role key is absent, `getDoctorsList` throws. The desk renders an explicit error state — "Doctor list unavailable. Tell an admin." — never an empty list. This interacts directly with D14: the volunteer desk's blanket catch currently converts that throw back into an empty list, so D14 must land in the same pass or this fix is invisible.

Move `DoctorOption` to the shared types module. No server module imports from a client component.

### D14 — Errors and empty states (#31)

Two rules, applied everywhere.

**No raw database text reaches a user.** Route every Postgres error through the message-mapping helper the registration API already has. Log the raw error server-side with enough context to debug; show the camp worker a mapped message.

**A failed load renders as a failure.** Delete the blanket try/catch on the volunteer desk and the two on the doctor desk. Let a failed load produce an error state that says what failed and offers a retry. "Empty" is reserved for a query that succeeded and returned nothing, and its copy must say so — "No one is waiting" reads differently from "Queue could not be loaded".

Delete the narrower-query fallbacks on the doctor and volunteer pages. They were a workaround for a schema state that no longer exists and now only swallow real errors such as an RLS denial.

### D15 — Realtime and polling (#25, #26)

Subscribe to patient-row changes for the active camp on the volunteer desk, the doctor station and the admin dashboard. Patient-facing screens keep the existing fixed poll unchanged — they do not need sub-second position and the risk is not worth it.

- Tear down on unmount and on camp change. A navigation must not leak a channel.
- On disconnect, fall back to the existing fixed poll **and show a visible "reconnecting — refreshing every 2 minutes" indicator**. A silent degradation to stale data is the failure mode camp connectivity guarantees.
- On reconnect, refetch once immediately before resuming live updates, then hide the indicator.
- Once the staff screens are live, remove the poll hook from them only. Keep the module — patient screens still use it.
- Replace both `unstable_cache` call sites with the supported cache API for this Next version. Tag-based invalidation on doctor changes must survive; verify it, do not assume it.
- **Decision on the seat board:** it joins Realtime alongside the queue. One refresh rule across both, so two numbers on the same screen are never from different moments.

### D16 — Component decomposition (#27, #28, #29)

Extract logic into **pure modules under `src/lib`** and test those modules at the existing `node:test` seam. This is the pattern #35 established with the registration request module and it worked — no new test framework, real behavioural coverage.

- **Scanner:** camera acquisition and teardown; decoding behind one interface covering both the native detector and the library fallback; scan resolution as a reducer with an explicit status union replacing the loose boolean flags. The generation counter and mounted guards are protecting real teardown races — preserve that behaviour exactly. Test the reducer and the decode-interface selection as pure modules; cover camera teardown at the Playwright seam.
- **Registration form:** OTP gate, Aadhaar autofill and form body as separate components over one reducer. Aadhaar autofill keeps its debounce, abort and stale-response handling — extract it as a pure module and test those three properties directly. **Decision:** OTP send must no longer create an Auth user eagerly. Create the user only on successful verification, so an abandoned attempt leaves nothing behind.
- **Optimistic reconciliation:** one convention, applied in all three components. **Decision:** derive from server props each render and hold only the pending-mutation set in state, keyed by patient id. No component branches on the reference identity of a prop. A failed refresh restores the pending item to the list and shows an error — it must not vanish.
- Extract the doctor-picker once and use it in all three places it is currently duplicated.

No behaviour change beyond the OTP fix, which is called out above.

### D17 — Accessibility (#30)

- The password dialog becomes a native `dialog` element opened as a modal. That gives focus trapping, Escape and the top layer without hand-written handlers. Restore focus to the trigger on close.
- Make every scrollable region keyboard-reachable.
- Remove `aria-label` from non-interactive `div`s. The jump-chip rows are navigation — mark them as such.
- The queue count live region announces only on change, and only when the count actually differs from the last announced value.
- Doctor selection becomes a single-choice control (radio semantics), not toggle buttons with pressed state.
- Collapsible section titles become real headings.
- The shared button's loading state must preserve non-string children.
- Verify by keyboard and with a screen reader, and check contrast at outdoor brightness. A linter pass is not the verification.

### D18 — UI reconciliation (#33)

- **Date formatting:** one convention — parse camp dates as `YYYY-MM-DDT00:00:00+05:30` and render in the Asia/Kolkata zone. The noon-anchored variant is deleted. Both currently reach the same answer by different means, which is luck.
- **Badge tones:** delete every declared tone variant no caller produces.
- **Print sheet QR:** make the compact payload a **required** prop and delete the long-URL fallback. Every current caller passes it; the fallback exists only to let a future caller silently print a denser, worse-scanning code.
- Remove the pointless variable aliases in the two components that carry them.
- Where the built UI and the Emerald & Slate spec disagree, **the built UI wins unless the spec's version is measurably better in field conditions** — contrast, tap target, or glare legibility. Record each deliberate divergence in the spec document rather than changing the code to match a document nobody has revisited.

### D19 — Offline resilience (#32)

For each of registration submit, scan lookup, doctor assignment and camp-day change, define and test the connection-loss behaviour:

- Registration submit — safe to retry once D8 lands; offer a retry that reuses the same request id.
- Scan lookup — read-only; retry freely.
- Doctor assignment — server-side guarded against double assignment; offer retry, and on success-after-timeout show the already-assigned state rather than an error.
- Camp-day change — offer retry; the seat-limit lock makes it safe.

**Decision on print-then-queue ordering:** printing continues to move the patient into the queue **before** the print dialog opens, and this is deliberate. The queue entry is the operationally meaningful act; the paper is a convenience. A cancelled print therefore leaves the patient queued, which is the correct outcome — they are physically at the desk. Say so in `CONTEXT.md` under Desk Slip so it stops being an accident.

No operation may be silently lost. If a mutation fails and cannot be retried automatically, it stays visible on screen as a failed action with a retry control.

### D20 — Documentation truth (new)

The README's "Camp flow (v3)" describes the pre-#15 world: "optional one-time backup password", logout "without changing patient credentials", no mention of the desk-slip passcode. `CONTEXT.md` and ADR 0001 describe the current one. Rewrite the README flow to match, and add a short "Auth model" section pointing at ADR 0001 as the authority. Any future change to the auth model updates all three or none.

### D21 — Ticket rewriting standard (new)

Every open ticket is rewritten so that an executor agent needs to make **zero** product decisions. Each ticket carries:

- **What to build** — the end-to-end behaviour, from the user's perspective.
- **Decisions already made** — every choice, stated flatly, with the rejected alternative and why. Lifted from this spec.
- **Acceptance criteria** — checkable, each naming its verification command.
- **Verification** — the literal commands to run and what output constitutes a pass.
- **Blocked by** — real blocking edges.
- **Do not do** — the specific wrong turns available on this ticket.

A ticket containing the words "decide", "consider", or "may be correct" is not ready for an agent.

## Testing Decisions

### What makes a good test here

A good test fails when the product breaks and passes when it does not. It asserts on observable behaviour: a response body, a status code, a redirect, a rendered role or region name, the payload a module sends, the value a reducer returns. It does not assert on the text of the source that produces that behaviour.

The suite has been through this once already. #8 deleted 2,180 lines of source-text tests that "passed while registration was broken", and #35 rebuilt one flow's coverage properly by extracting the outbound path into a pure module and driving it with a mocked transport. That pattern is the template for everything below.

### Seams — four existing, zero new

1. **`node:test` behaviour suite (`tests/*.test.mjs`)** — the primary seam. Pure modules and route handlers, driven directly with mocked Supabase clients and mocked `fetch`. Everything that can be tested here, is. Prior art: `tests/registration-request.test.mjs` mocks `fetch` and `rpc` and asserts on captured payloads; `tests/core.test.mjs` covers QR parsing, phone normalisation, rate limiting, reg-number parsing and assignment.
2. **`tests/security-invariants.test.mjs`** — the deliberate, bounded exception defined in D4. Three invariants. Additions require the D4 test spelled out in the ticket.
3. **Playwright role suite (`e2e/roles.spec.ts`)** — the highest behavioural seam. Real auth, real database, disposable labelled fixtures created and torn down by the global setup. This is where camera teardown, focus management, keyboard navigation and the deep-link scan handoff are proven. Prior art: the suite already covers public redirects, all four role sign-ins, lookup-without-mutate, secrets-not-in-URL under `javaScriptEnabled: false`, and patient login with reg number plus passcode.
4. **`npm run verify`** — the gate. Lint, unit, production build, in that order, in one run.

Supporting, not seams: `GET /api/health?ready=1` as a deploy gate, `scripts/load-test.mjs` for latency evidence against the 800ms desk / 500ms scan-lookup SLOs.

**Explicit decision: no React DOM test harness is added.** The decomposition tickets (#27, #28, #29) would each be easier with one, and the temptation is real. It is rejected because a fifth seam means a fifth way to write a test, and the #35 pattern — extract the logic to a pure module, test the module, cover the DOM at Playwright — has already been shown to work on this codebase without one. Component logic that cannot be extracted into a pure module is a signal the decomposition is not finished.

### What gets tested, per area

- **Auth surface** — patient login response shapes for success, wrong reg, wrong passcode and rate-limit exhaustion, all at the route-handler seam; role predicates as pure unit tests; role landing and sign-out at Playwright.
- **Provisioning** — idempotency under repeat call and under concurrent call, at the route-handler seam with a mocked admin client.
- **Registration** — replay by request id including the null-camp-day case; seat limit under N-concurrent-vs-M-seats. These need a real database, so they run against a disposable project, not mocks.
- **Phone linking** — zero, one and many matches, as behaviour on the RPC.
- **Reducers and pure modules** — scanner scan-state, form state, Aadhaar debounce/abort/stale-response, optimistic reconciliation, date formatting, message mapping.
- **Realtime** — subscribe, teardown on unmount, teardown on camp change, disconnect falls back to poll, reconnect refetches once. Drive the subscription module directly with a fake channel; assert on the calls it makes.
- **Accessibility** — dialog focus trap, Escape, focus restore, and keyboard reachability of scroll regions at the Playwright seam. Contrast and screen-reader passes are manual and recorded in the ticket.
- **Schema** — every migration ticket attaches `EXPLAIN` output or a `db reset` transcript. RLS coverage stays in the invariant suite.

### Coverage reporting rule

Any change that deletes tests states what is no longer covered. A rising pass count after a deletion is close to tautology and must never be offered as evidence of health on its own. This rule exists because it was violated in #8 and the retrospective on that ticket is the best writing in this repository's history.

## Out of Scope

- Live SMS/WhatsApp OTP delivery against a real handset. Contract-level coverage only; the readiness endpoint reporting `phoneOtp: false` is the honest signal.
- Physical camera QR trials — blur, lighting, distance, real device timing. Payload generation, parsing, deep-link routing and scanner workflow remain in scope under automation.
- Applying any production migration without explicit human sign-off recorded on the ticket.
- A brand redesign of the operational desks. D18 reconciles what exists; it does not restyle.
- Rewriting the queue as a websocket-first architecture. D15 adds a subscription over the existing server-rendered pages.
- New third-party Aadhaar or SMS providers beyond the existing optional webhook hooks.
- Any non-`main` branch or alternative framework port.
- Load testing at thousands of virtual users against production.

## Further Notes

### Open questions for the operator — these block their tickets

1. **D5, legacy patient accounts.** How many patient accounts predate the passcode scheme, and is reissuing at the desk acceptable for all of them? If the number is large, a bulk pre-print of slips may be needed before camp day.
2. **D10, Aadhaar override.** Who is allowed to override a duplicate-registration block — admin only, or any staff? The spec assumes staff with attribution; confirm.
3. **D3, disposable project.** Is there a non-production Supabase project available to rehearse `db reset` against? If not, the rehearsal happens locally under Docker, which was unavailable during #9 and is the reason that ticket's proof is incomplete.

### On the work so far

The technical judgement across #1–#35 was consistently strong. Deleting 2,180 lines of green tests because they "passed while registration was broken" was correct and unpopular. Splitting `isStaff` into two predicates rather than forcing one to match the other was the right read of a subtle domain problem — both meanings were genuinely needed. Refusing to apply a squashed baseline to a live database was right. The retrospectives written on #7, #8 and #9 diagnose their own failures more precisely than most human post-mortems.

The weakness is uniform and it is about closure, not construction. Work was declared done one step before the step that proves it, and the missing step was almost always the cheap one: run the linter, run the browser suite, check whether the file you put the test in is queued for deletion, run the `init` command that carries no risk. The red `verify` on `main` is the accumulated cost.

D1 exists to make that impossible rather than to ask for more care.

### Sequencing

`D2` (green lint) and `D3` (ledger) come first and block almost everything — the first because no other ticket can be verified while the gate is red, the second because six tickets touch the schema. `D4` (invariant boundaries) is independent and can run in parallel. The decomposition tickets depend on the behavioural suite being trustworthy, which is `D4`. The accessibility pass depends on the decomposition because it shares those files. The final verification sweep depends on everything.

### One thing not to lose

The generation counter and mounted guards in the scanner are protecting real teardown races. They read as over-careful and they are not. Whoever decomposes that component should preserve their behaviour exactly and add a Playwright test for rapid start/stop and unmount-mid-start before touching them.
