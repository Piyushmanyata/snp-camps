## Problem Statement

SNP Camps is a live medical-camp desk (Sikar Nagarik Parishad). Staff and patients already rely on registration, queue, print, and QR scan flows, but there is no single, evidence-backed pass that proves the system is correct, secure, usable, and fast enough for camp day across every role and edge case. Failures today are discovered ad hoc: some areas already have strong automated contracts (unit tests green, lint and production build green), but the full matrix—backend, security, UI/UX/visuals, end-to-end role workflows, performance SLOs, QR generation and automated scan paths, and ease of use—has not been systematically exercised, ranked, and fixed to green. The operator needs confidence that camp day will not break on auth, wrong-role access, re-scan of seen patients, slow desks, broken QR routing, or confusing empty/error states—and that every found failure is fixed or explicitly deferred with a reason.

## Solution

Run a full-system audit and hardening pass on the **main** branch of the Next.js + Supabase camp desk only: baseline health and measurements, then systematically review and fix backend/API/RPC behavior, security (auth sessions, RLS contracts, service-role isolation, BOLA/IDOR), UI/UX/visuals and accessibility, every role end-to-end workflow, performance against stricter camp-day SLOs, QR generate/parse/deep-link behavior (automated only), and edge cases—until the matrix is green or remaining gaps are explicitly deferred. Work only against the current Supabase project from local app runs; create only labeled disposable E2E fixtures and clean them up; propose any SQL/migrations for approval rather than applying them silently. Deliver a working main branch plus verification evidence (unit, e2e, load/timing, security checks).

## User Stories

1. As a camp organizer, I want a single verified pass over the whole desk product on main, so that I know camp day will run without surprise failures.
2. As an admin, I want to sign in with email and password, so that I can manage camps and staff.
3. As an admin, I want disabled staff accounts blocked from desk access, so that former volunteers or doctors cannot act after disablement.
4. As an admin, I want to create and activate a camp and camp days with seat limits, so that registration capacity is controlled.
5. As an admin, I want to create volunteers and doctors, so that only authorized staff work the camp.
6. As an admin, I want dashboard counts and seat boards that load quickly, so that I can run the desk without waiting.
7. As an admin, I want to search and filter patients by queue status and reg no, so that I can find people at the desk.
8. As an admin, I want to scan or look up a patient and assign a doctor, so that patients move through the queue correctly.
9. As an admin, I want to print optional desk sheets without breaking the queue contract, so that paper workflows remain optional.
10. As an admin, I want to sign out completely, so that the next person at the shared desk cannot use my session.
11. As a volunteer, I want to sign in and land on the volunteer desk, so that I can register and process patients.
12. As a volunteer, I want to register patients when allowed, so that walk-ins enter the system with correct day and seat rules.
13. As a volunteer, I want to look up by reg no or QR payload without mutating state until I confirm, so that mistaken scans are safe.
14. As a volunteer, I want to print and place a patient into the waiting queue, so that doctors can see them in FCFS order.
15. As a volunteer, I want to pick a doctor when assigning a waiting patient, so that the right clinician is recorded.
16. As a volunteer, I want a live (or refreshable) waiting queue, so that I can manage line flow.
17. As a volunteer, I want clear errors when the camp is full, inactive, or the patient is already seen, so that I do not invent workarounds.
18. As a doctor, I want to sign in and land on the doctor desk, so that I only see doctor tools.
19. As a doctor, I want scan or reg lookup that is read-only until I confirm, so that accidental opens do not mark patients seen.
20. As a doctor, I want to confirm a patient and mark them seen without requiring a prior print, so that digital-only camps work.
21. As a doctor, I want re-scan of an already-seen patient blocked with who saw them, so that double-processing is prevented.
22. As a doctor, I want stats and queue context that meet camp-day latency targets, so that my clinic pace is not blocked by the app.
23. As a patient, I want to self-register with phone OTP when configured, so that I can enroll without a staff account.
24. As a patient, I want registration to fail closed when phone linking fails, so that orphan or inconsistent accounts are not created.
25. As a patient, I want to see my reg number and queue status after login, so that I know where I stand.
26. As a patient, I want a staff-scan QR (not a patient-login QR), so that only desk staff use the code for processing.
27. As a patient, I want patient login by registration number (and password when required), so that I can re-open my profile.
28. As a patient, I want logout that ends my session without rotating credentials unexpectedly, so that recovery remains predictable.
29. As a patient, I want seat-board and day information that is accurate, so that I know if the camp day is full.
30. As a public visitor, I want clear entry points for patient vs staff login, so that I do not use the wrong door.
31. As a public visitor, I want protected desks to redirect to the correct login, so that private data is not exposed.
32. As staff scanning a QR while logged out, I want to be guided to staff login or QR help rather than patient auto-login, so that QR never logs patients in by scan.
33. As staff opening a short patient QR path or deep-link scan query, I want routing to my role desk with lookup-first behavior, so that scan handoff is reliable.
34. As staff with a paper QR using compact scheme or legacy URL forms, I want parse to succeed, so that old and new codes both work.
35. As staff entering garbage or oversized QR text, I want safe rejection, so that the scanner does not crash or hit the DB wrongly.
36. As a security reviewer, I want session checks to use verified auth claims, not untrusted client metadata, so that roles cannot be spoofed.
37. As a security reviewer, I want the service role key never exposed to the browser, so that admin APIs stay server-only.
38. As a security reviewer, I want patient rows protected so one patient cannot read another patient by id, so that BOLA/IDOR is prevented.
39. As a security reviewer, I want staff RPCs for lookup, assign, and print executable only by the intended roles, so that anonymous callers cannot mutate the queue.
40. As a security reviewer, I want rate limiting and bounded JSON bodies on sensitive APIs, so that abuse and oversized payloads fail closed.
41. As a security reviewer, I want Aadhaar stored as last4 only, so that full identity numbers are not retained.
42. As a security reviewer, I want passwords and OTPs never placed in URL query strings, so that secrets do not leak via history or logs.
43. As an operator, I want health liveness and readiness checks, so that deploy readiness is observable.
44. As an operator, I want readiness to report database shape and phone OTP configuration honestly, so that we do not go live half-configured.
45. As an operator, I want desk pages to meet p95 under 800ms after baseline and fixes, so that shared tablets stay responsive.
46. As an operator, I want scan lookup RPC p95 under 500ms after baseline and fixes, so that scan-to-card feels instant.
47. As an operator, I want load smoke with low error rate under realistic read traffic, so that camp-day concurrency does not collapse the site.
48. As an operator, I want no aggressive live polling (fixed long interval or manual refresh), so that platform cost and load stay controlled.
49. As a volunteer on a phone, I want primary actions (register, scan, save) reachable without desktop-only traps, so that mobile desk work is possible.
50. As any role, I want loading, empty, and error states that explain next steps, so that I am not stuck on a blank screen.
51. As a keyboard user, I want labeled fields, visible focus, and operable scanner controls, so that the desk is usable without a mouse.
52. As a screen-reader user, I want landmarks, status regions, and named review panels, so that lookup results are announced.
53. As a low-vision user, I want sufficient contrast and readable reg numbers/QR, so that desk printouts and screens are usable in hall lighting.
54. As a developer, I want existing unit contract tests to remain the first gate, so that regressions are cheap to catch.
55. As a developer, I want Playwright role e2e against local loopback with disposable Codex E2E fixtures, so that real auth and DB paths are proven without polluting permanent data.
56. As a developer, I want failures fixed with the smallest correct change, so that the product stays simple.
57. As a developer, I want SQL/migration proposals only when a real failure requires them, so that production schema is not risked without approval.
58. As a developer, I want real SMS OTP and physical camera QR deferred, so that third-party and hardware gaps do not block the rest of the matrix.
59. As a developer, I want every acceptance criterion traced to evidence (test output, timing, or explicit deferral), so that done is not a vibe check.
60. As camp staff, I want invalid QR help pages when non-staff open a patient QR, so that patients are not confused into thinking scan is login.
61. As camp staff, I want concurrent double-submit of assign or print to not create inconsistent queue states, so that FCFS integrity holds.
62. As camp staff, I want seat-full registration to be refused with a clear message, so that overbooking does not happen silently.
63. As camp staff, I want changing camp day for a patient (where supported) to preserve invariants, so that day stats stay coherent.
64. As an admin viewing staff detail, I want attributed activity (who registered / who saw), so that accountability on camp day is clear.
65. As any user on a slow network, I want progressive or bounded loading rather than multi-second freezes, so that the desk feels operable under camp Wi-Fi.

## Implementation Decisions

### Scope and branch
- Work **only on main** of the SNP Camps Next.js app. Other branches were removed; do not revive alternate ports in this effort.
- Full matrix until green or **explicitly deferred** (not critical-path-only).

### Environment and data
- Run the local app against the **current Supabase project** already configured for the team.
- Mutate only **labeled disposable fixtures** (Codex E2E-style users, patients, optional camps) created by the e2e setup path; always clean up.
- Do not run destructive bulk ops on real named camp patients.
- Do not call live SMS providers for Auth OTP as a pass criterion; cover OTP **UI and API contracts** only.
- Do not require physical camera hardware; QR coverage is **payload generate/parse, deep-link routing, scanner UI workflow, and RPC lookup contracts** under automation.

### Performance SLOs (stricter camp-day)
- After measuring baseline, fix toward:
  - Desk page interactions / key server-rendered desks: **p95 under 800ms** under the measurement environment used for baseline.
  - Scan lookup path (RPC + response handling): **p95 under 500ms**.
  - Load smoke: keep error rate very low (target under 1% on the existing read-only load harness defaults) while reporting p95 honestly.
- Preserve the product decision of **manual refresh or long fixed poll** for boards (no high-frequency live websockets).

### Security and auth
- Staff and patient sessions must continue to be established through Supabase Auth with server-side session handling suitable for the App Router.
- Authorization must use **server-verified identity and profile role** (and disabled timestamp), never editable user metadata for role decisions.
- Service-role usage remains **server-only** for bootstrap, patient account linking, and admin creation paths that already require it.
- RLS and security-definer RPC grants are validated via existing database-hardening style contracts; **schema changes are proposed as migration drafts only** and applied only after human approval.
- Sensitive routes keep bounded JSON parsing, authz checks, and fail-closed behavior on misconfiguration.

### Domain workflows to preserve
- Queue states: **registered → waiting (optional print / mark printed) → seen** (once).
- Doctors may mark seen **without** print; re-seen is blocked with attribution.
- Patient QR is **staff-scan only** (compact scheme and short path forms); never patient login via QR.
- One active camp, FCFS waiting queue; seat limits on camp days.
- Aadhaar: last four only at rest.

### Frontend quality bar
- Product desks (admin, volunteer, doctor, patient): craft and critique under a production product-UI standard (hierarchy, empty/error, mobile reachability, copy clarity)—not a marketing redesign of operational tables.
- Public entry shell may receive light anti-templated polish only if it fails usability; do not restyle the whole brand without need.
- Accessibility target: WCAG-oriented fixes for labels, focus, contrast, live regions, target size on primary actions.
- Prefer the **smallest correct UI fix** that removes a failure; avoid speculative design-system rewrites.

### Skills and methods (non-overlapping)
- Supabase platform + Postgres best practices + Next.js Supabase auth for backend/security.
- Web performance skill + Vercel React/Next performance practices for SLOs (CWV/load vs React waterfalls/bundles).
- Impeccable + frontend-design for product UI fixes; design-taste only if public landing truly fails (that skill is not for dashboards).
- Accessibility for WCAG; webapp testing + existing e2e for browser proof; diagnosing-bugs for hard regressions; lean-ctx for exploration; ponytail for minimal diffs.

### Execution order
1. Baseline: unit suite, lint/build, health readiness, e2e if env allows, load/timing baseline.
2. Security and auth matrix.
3. Role E2E + QR automated matrix.
4. UI/UX/a11y/visual failures found in desks.
5. Performance fixes to SLOs.
6. Edge cases and final verification with evidence.

### Change control
- No production SQL apply without explicit approval.
- No secrets in commits or issue text.
- Fixes land as small reversible batches with verification after each batch.

## Testing Decisions

### What good tests look like
- Assert **external behavior and contracts**: HTTP status and JSON shape, redirects, visible role outcomes, pure QR parse results, RPC grant/body contracts, performance numbers—not private component implementation details or brittle CSS class names unless they encode accessibility contracts already used in-repo.
- Prefer **highest existing seams**; do not invent a second e2e framework or a parallel assertion style.

### Primary seams (please confirm)
1. **Playwright role e2e (highest behavioral seam)** — local loopback app + disposable fixtures from global setup/teardown. Proves public redirects, staff/patient sign-in, desk headings, lookup-without-mutate, sign-out. Extend this suite when a role workflow gap is found.
2. **Node test contract suite (existing unit test command)** — pure QR helpers, scanner/print/auth workflow source contracts, database-hardening expectations, security config, a11y/resilience strings, performance-oriented static checks already present. Extend this suite for regressions.
3. **Load harness (existing load smoke script)** — read-oriented capacity and latency signals against a chosen base URL; use for SLO evidence, not for destructive writes by default.
4. **Health readiness endpoint** — deploy/config gate (DB shape + phone OTP configuration flags).

Ideal count of *new* seams: **zero**. New coverage should attach to the seams above. Pure QR parse remains a unit seam inside the node suite (already exists).

### Surfaces under test
- Auth session and role home routing
- Patient register/login/account APIs (contract-level)
- Print API and queue transition
- QR generate/parse and staff-scan entry routing
- Scanner lookup-then-confirm behavior (automated)
- Admin staff APIs
- RLS/RPC privilege contracts (schema/tests; advisors only if available without side effects)
- Desk pages performance and loading states
- Accessibility contracts already encoded in workflow tests

### Prior art in this repo
- Large node:test matrix (role routing, QR challenger, scanner workflow/performance, patient auth, print, database hardening, config security, a11y resilience, logout, staff credentials).
- Playwright roles spec with fixture bootstrap and remote-request allowlisting to Supabase + loopback.
- Load smoke script with high-load guardrails.
- Verify script = lint + unit tests + production build.

### Evidence required for done
- Unit: pass
- Lint + build: pass
- E2E roles: pass (or documented env blocker)
- Perf: baseline + post-fix measurements vs 800ms / 500ms targets
- Security: contract tests pass; any residual schema risk listed for human approval
- Explicit deferrals: live SMS OTP, physical camera QR timing

## Out of Scope

- Physical camera QR timing, blur, and lighting trials on real devices
- Live SMS/WhatsApp Auth OTP delivery success against a real handset (contracts only)
- Applying production database migrations without human approval
- Non-main branches, SvelteKit or other ports
- Full brand redesign of operational desks for aesthetics alone
- WebSocket/realtime queue rewrite
- New third-party Aadhaar/SMS providers beyond existing optional webhook hooks
- Load testing at thousands of virtual users against production without the harness coordination flags already enforced

## Further Notes

### Domain vocabulary (use consistently)
- **Active camp**, **camp day**, **seat limit / seats left**
- **Reg no**, **patient**, **queue status**: registered | waiting | seen
- **Staff roles**: admin, volunteer, doctor
- **Desk** (role home), **FCFS queue**
- **Staff-scan QR** (not patient login), compact payload and short path entry
- **Print** optional → waiting; **assign / mark seen** once with attribution
- **Phone OTP** self-registration path; synthetic patient emails for password accounts
- **Aadhaar last4** only

### Baseline already known (pre-execution)
- Unit tests: 100/100 pass
- Lint and production build: pass
- Env present for Supabase URL, anon/publishable, service role, site URL
- Product README documents camp flow v3 and verification commands

### Testing seams for human confirmation
The executor should treat the four seams listed under Testing Decisions as the **only** intentional seams. If you disagree (for example, wanting a separate Lighthouse CI gate or staging-only e2e), say so before implementation expands.

### Skill load order reminder
Load backend skills for security batches; performance + React perf for SLO batches; impeccable/accessibility for UI batches; avoid loading overlapping design skills on desk tables.
