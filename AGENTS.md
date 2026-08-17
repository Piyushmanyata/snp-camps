# AGENTS.md

Operating rules for coding agents in this repo. Cheapest correct path wins.
Read this once. Do not re-read it. Do not summarise it back to the user.

## 0. Always on

| Setting | Value |
|---|---|
| Ponytail | `full` — run `/ponytail full` at session start, never lower it |
| Context reads | lean-ctx modes only (§2) |
| Dev servers, browsers, computer use | Forbidden (§7) |
| Code comments | None, except the one workaround case in §8 |
| Final answer | Blocked until §9 gate passes |

## 1. Token budget

Defaults. Override only if the user gives a number.

| Phase | Budget | Hard stop |
|---|---|---|
| Orientation before first edit | 15k | Stop reading, start a subagent instead |
| One subagent | 25k in / 300 words out | Return partial findings, say so |
| Review subagent | 15k / 200 words | Return top 3 findings only |
| Whole task | 120k | Report progress, ask before continuing |

Rules:

- Never read a file you are not going to edit or reason about.
- Never re-read a file you already read this session; use `ctx_session` recall.
- Never paste tool output into the response. Report conclusions only.
- Quote exact code, numbers, and errors. Summarise everything else.

## 2. Reading context (lean-ctx)

Ladder — stop at the first rung that answers the question.

1. `ctx_overview(task)` — task-relevant project map
2. `ctx_semantic_search(query)` — find the code by meaning, not filename
3. `lean-ctx read <file> -m map` — purpose, deps, exports
4. `lean-ctx read <file> -m signatures` — API surface
5. `lean-ctx read <file> -m aggressive` — body logic, syntax stripped
6. `lean-ctx read <file> -m entropy` — file is repetitive (generated, fixtures, logs)
7. `lean-ctx read <file> -m diff` — re-checking a file you already read; use this
   after every edit instead of re-reading the file
8. `lean-ctx read <file> -m full` — only for files you are about to edit
9. `lean-ctx -c <cmd>` — any verbose shell (git, npm, test, build, docker)

Also: `ctx_knowledge` to persist facts across sessions, `ctx_refactor` for renames
and reference-finding, `ctx_gain` when the user asks what was saved.

Banned: `cat` on a whole file, recursive `ls`/`find` to "look around", reading a
directory tree by hand, full-file Read when `map` or `signatures` would do.

## 3. Enough context before changing code

Do not edit until all four are true:

1. You can name the exact file(s) and symbol(s) that change.
2. You have read every caller of the symbol you are changing (`ctx_refactor`).
3. You know which test proves the change works, and have run it red first.
4. You know the existing pattern this repo already uses for this problem.

If any is false, gather it — or spawn one Explore subagent to gather it (§5).
A wrong edit costs more tokens than the read that would have prevented it.

## 4. Research before applying

For anything non-obvious (new dep, new pattern, unfamiliar API, perf fix):

1. Check the repo first — the pattern probably exists already.
2. Then the installed dependency's own docs/types.
3. Then the web, primary sources only (`research` skill).
4. Write the chosen approach in one sentence with the rejected alternative.
5. Then implement.

Never implement the first idea that compiles. Never invent an API — verify it.

## 5. Subagents

Use them aggressively for anything that fans out. They are how work goes parallel
and how the main context stays small.

Spawn a subagent when: searching >3 files, exploring an unknown area, running an
independent sub-problem, or reviewing (§9).

Every subagent prompt uses this contract. No exceptions.

```
GOAL: <one sentence, testable>
DONE WHEN: <exact artefact — file list, patch, 3 findings, yes/no>
BUDGET: <n> tokens, <n> tool calls
STOP EARLY IF: answer found | 2 dead ends | budget 80% spent
CONTEXT: <paths + facts already known — do not rediscover these>
FORBIDDEN: re-reading AGENTS.md, full-file reads, running the full suite,
           dev servers, editing files outside <scope>
RETURN: <=300 words. Conclusions + file:line. No transcripts, no code dumps.
```

Rules:

- Max 4 concurrent. Never two agents editing the same file.
- Read-only agents (Explore, review) may run wide; writing agents stay narrow.
- A subagent that hits budget returns what it has. It never silently continues.
- Give the subagent the facts you already know. Re-deriving context is the
  single biggest token leak.

## 6. Parallel work

1. Split the task into sub-problems with no shared files.
2. Fan them out in one batch of tool calls / one batch of subagents.
3. Integrate, then verify once at the end.

Batch independent tool calls in a single block — never serialise calls that do
not depend on each other. Sequence only true dependencies.

## 7. Verification — no dev servers

Forbidden: `npm run dev`, watch mode, browsers, screenshots, computer use,
manual clicking, "start the server and check".

Use instead, in this order:

1. Typecheck — `tsc --noEmit` (or repo equivalent)
2. Lint
3. Targeted test — single file or single test name, while iterating
4. Build — only if the change could break it
5. Full suite — once, at the end, before answering

Run these through `lean-ctx -c` so failures come back compressed. On failure,
read only the failing frame, not the whole file.

## 8. Code style

- Simplest thing that works. Complex feature, simple build. Ponytail decides ties.
- Ponytail's ladder — what `full` mode enforces — before writing anything: does it
  need to exist → already in the codebase → stdlib → native platform → installed
  dep → one line → minimum that works.
- No comments. Names and types carry the meaning. Sole exception: a non-obvious
  workaround, one line, with an issue link.
- No abstraction until the third occurrence. No config for one call site.
- No defensive layers, no speculative options, no "future-proofing".
- Never weakened: validation, error handling, security, accessibility, types.
- Delete dead code as you pass it.

## 9. Definition of done — the gate

Do not send a final answer until every line is true.

1. Full test suite passes. Typecheck passes. Lint passes.
2. Two adversarial reviews ran as subagents, in parallel, 15k each:
   - **Correctness**: find the input that breaks this. Bugs, missed callers,
     broken edge cases, untested paths. Return `<=3` findings, worst first.
   - **Simplicity**: what here should not exist? Over-abstraction, dead options,
     code a stdlib call replaces. Return `<=3` findings, worst first.
   Both are told to return "no findings" rather than invent something.
3. Every confirmed finding is fixed or explicitly declined with a reason.
4. Tests re-run and pass after the fixes.
5. Docs updated in the same change (§10).

If tests do not pass, say so plainly and stop. Never report a partial pass as done.

## 10. Docs

Follow the mattpocock convention. Docs are part of the change, not a follow-up.

| Artefact | When |
|---|---|
| ADR | Any decision with a rejected alternative — context, decision, consequence |
| Glossary / ubiquitous language | New domain term appears in code |
| Domain model | Entity, relationship, or invariant changes |
| Module doc | Public interface of a deep module changes |

## 11. Skills

The mattpocock skills are the default working method, not a fallback. Route every
task through this table and read the skill before starting, not halfway through.
A repo-local skill for the same job overrides the row; nothing else does.

| Task | Skill |
|---|---|
| Unsure which skill | `ask-matt` |
| Plan or spec is fuzzy | `grill-me`, `batch-grill-me` |
| Plan + docs together | `grill-with-docs` |
| Build a feature | `tdd`, then `implement` |
| Hard bug or perf regression | `diagnosing-bugs` |
| Review a diff | `code-review`, `review` |
| Module or interface design | `codebase-design`, `design-an-interface` |
| Work too big for one session | `wayfinder` |
| Split a plan into tickets | `to-tickets`, `to-spec` |
| Domain terms | `domain-modeling`, `ubiquitous-language` |
| Answer an unknown | `research` |
| Throwaway spike | `prototype` |
| Out of context | `handoff`, `claude-handoff` |
| Merge conflicts | `resolving-merge-conflicts` |

Improvising when a row matches is a defect.

## 12. Reporting to the user

Short. Numbers first. No filler, no preamble, no recap of steps already shown.
State assumptions in one line. Ask only when the answer changes what you build.


<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Agent Governance Rules — SNP Camps

## What this app is

A desk tracker for a free eye camp. It moves a patient through
`registered → seen` and prints a prescription form. **The paper is the
clinical record.** Print prescription records presence (`printed_at`) and
prints paper; it does not maintain a line. Read
[`docs/adr/0013-no-fcfs-queue.md`](docs/adr/0013-no-fcfs-queue.md) and
[`docs/adr/0008-printing-queues-the-patient.md`](docs/adr/0008-printing-queues-the-patient.md)
before proposing a line, a third lifecycle state, or a clinical feature.

The desk has exactly two actions: **Print prescription** (paper + presence)
and **Mark seen**. If a change adds a third, question it hard.

## Document Authority Precedence

When governing documentation conflicts, resolve in this order:

1. **`docs/adr/`** — architectural decision records. ADR 0013 defines the lifecycle (no FCFS Queue). ADR 0008 still defines paper-as-record and the two desk actions. ADRs 0001, 0002, 0006 and 0007 are superseded and retained for the reasoning, not the decision.
2. **`CONTEXT.md`** — ubiquitous language, domain context, lifecycle invariants, role boundaries, accepted design-system rules.
3. **`README.md`** — operations, deployment setup, build/verify gates, auth model reference, MSG91 configuration.

A spec under `docs/specs/` is a work order, not a governing document. An accepted spec that changes a rule in this list must amend that document in the same branch — an unamended conflict resolves against the spec.

## Production Safety

* **Production is NEVER assumed to be empty.** Running `db reset` or re-applying baseline SQL against production is strictly prohibited. Schema changes must use append-only incremental migrations validated via clean replay on a disposable database (`npm run test:db:replay`).
* Migration `20260728119000` dropped the retired clinical tables irreversibly. That was a **one-time, explicitly authorised exception** taken while production held test data only and no real camp had run. It sets no precedent: once real camp data exists, removals must archive rather than drop, and any irreversible migration needs fresh explicit confirmation.
* **Realtime Boundary**: Public patient Realtime channels are retired. The `patients` table is strictly absent from the `supabase_realtime` publication (`patients_realtime_absent` check).
* **Polling**: Seat board and desk updates use manual Refresh or fixed polling — zero public WebSocket channels on patient rows.
* **Least Privilege**: `is_staff()` (admin, team_lead, volunteer) gates every desk RPC. `is_camp_crew()` is an **alias** of it, not a wider set — the doctor role was retired. Patients do not sign in and hold no Supabase Auth sessions. There is no public patient-facing status route.
* **Status Token Boundary**: The public status page, status token column, and `patient_status_by_token` are retired (ADR 0023). Do not reintroduce a public patient-facing route, a status token, or a grant on a token-resolution RPC. Recovery is desk name-search and Aadhaar re-scan.

## Postgres

* You cannot drop a value from an enum type. `user_role` still lists `doctor` and `patient`; `queue_status` still lists `waiting`. All three are dead labels; the app treats them as such. Disable residual rows rather than trying to remove the label.
* Changing a function's **argument list** creates a new overload rather than replacing the old one, and `CREATE OR REPLACE` cannot change a return type at all. When either changes, `DROP` the exact old signature explicitly and re-grant — a dropped-and-recreated function loses its grants, and a forked overload leaves the old one live. Check `pg_proc` afterwards.
* Preserve `FOR UPDATE` lock order and capacity guards when editing an existing RPC. `upsert_camp_day`'s row lock and `SEAT_LIMIT_BELOW_ASSIGNED` check exist to serialize capacity edits against concurrent registrations; rewriting the function without reading it first silently removes that protection.

## Visual & Design System

* UI must meet WCAG 2.2 AA for field legibility under bright outdoor light: high contrast, 44×44 minimum touch targets, visible focus rings, text scaling, tactile press scaling (`scale(0.98)`), clear solid status badges, and `prefers-reduced-motion` compliance.
* Retired visual guidance (glow typography, glassmorphism, glowing status badges) is removed and superseded by the design-system rules in `CONTEXT.md`.
* Patients and field staff read Hinglish; admin reads English. Mixing the two inside one surface is a bug.

## Testing & Evidence Governance

* Tests assert empirical runtime behaviour across four seams: the `node:test` unit suite, `tests/*.db.test.mjs`, the Playwright role e2e suite, and the full `npm run verify` gate. Brittle source-text regex assertions are discouraged — they break on rename and pass on rot.
* **A skipped database test is a failure, not a pass.** `npm run test:db` fails on any skip and names it a blocker. A test file may skip only when the database is genuinely unreachable. Guards that treat a *missing RPC* as "Postgres unavailable" silently delete coverage exactly when a migration breaks something — this has happened in this repo, and it hid three real failures.
* **A green suite is not evidence the app works.** Every defect found in the July 2026 audit passed the full suite. Verify against a running app.
* Do not claim a suite passed without the terminal output. Report skip counts explicitly. For a bug fix, show the test failing before the fix and passing after.
