# Spec — Final production pass: hydration recovery, Aadhaar eKYC self-registration, deploy-config truth

**Status:** ready-for-agent
**Date:** 2026-07-26
**Derived from:** empirical verification of `fix/gate-a-56-57-58` at `88e52d3` — clean `supabase db reset` replay, `npm run test:db` (81/81), `npm test` (280/280), `npm run lint`, `npm run build`, `npm run test:e2e` (**31 failed / 4 passed**), and direct browser inspection of a production `next start` server.
**Domain vocabulary:** `CONTEXT.md` (Camp, Camp Day, Patient, Staff, Camp crew, Patient QR, Status token, FCFS Queue, Check-in, Volunteer Desk, Doctor Station, Desk Slip, Seen)
**ADRs that constrain this spec:** `docs/adr/0001-passcode-on-desk-slip.md`
**Supersedes the closure claims of:** #64, #69, #72 (their Playwright evidence does not reproduce)

---

## Problem Statement

The operator believes this branch is shippable. Nineteen tickets (#56–#74) were closed against it, an adversarial review was run on top, and the handoff report declares every P0, P1 and P2 green with a per-ticket verification matrix.

**The application does not work in production.**

Served from a production build, the app emits eleven `<script src>` tags and **zero** `nonce` attributes, while its own `Content-Security-Policy` header declares `script-src 'self' 'nonce-…' 'strict-dynamic'`. Under CSP Level 3, `'strict-dynamic'` causes host-source expressions — including `'self'` — to be **ignored**. Every script on the page is therefore blocked. Verified directly in a browser against `next start`: `window.__next_f` is `undefined`, React never hydrates, and all eleven chunk requests fail.

The consequence is not cosmetic. Nothing that requires client JavaScript works: staff cannot sign in (the login form falls back to a native `POST` that never reaches Supabase), the QR scanner never starts, check-in, doctor assignment, the seat board, the A4 batch queue and every recoverable error island are inert. The app is a static brochure that renders correctly and does nothing.

Three further problems compound it.

**The gate cannot see this.** `npm run verify` is lint → unit → build → js-budget. All four pass. The browser suite is a separate opt-in command, and it is red: 31 of 35 tests fail, every one of them downstream of a sign-in that never completes. `e2e/csp.spec.ts` — the test written specifically to assert the page "hydrates cleanly" — is among the failures. The seam that catches this bug exists, works, and was reported as passing. Additionally `npx tsc --noEmit` is not clean (`e2e/a4-batch.spec.ts:240`, `TS2304: Cannot find name 'Route'`), which `next build` does not surface because it type-checks only its own module graph.

**The deploy configuration is quietly wrong.** The pulled production environment carries no `CRON_SECRET`. `authorizeCron` returns `false` when the secret is unset, so the nightly reminder job answers `401` and does nothing — every night, with no error anyone will see. It also carries `ADMIN_INVITE_CODE` and `VOLUNTEER_INVITE_CODE`, which no code in the repository reads: live secrets left over from a retired signup flow. And the handoff report instructs the deployer to set `MSG91_REGISTRATION_DLT_TE_ID` and `MSG91_REMINDER_DLT_TE_ID`, while the code reads `MSG91_TEMPLATE_REGISTRATION` and `MSG91_TEMPLATE_REMINDER` — following the handoff produces an SMS integration that is silently dead.

**Patients cannot register themselves, and the operator now needs them to.** Registration is desk-only by design (#45 retired public self-registration). The operator wants a self-service path gated on Aadhaar verification, with demographics pulled from eKYC, ready to plug into Digio or Decentro when credentials exist. Today there is no OTP infrastructure of any kind — `grep -i otp` across `src/` and `supabase/` returns a single comment — and `register_patient_idempotent` hard-rejects any authenticated caller lacking an active `admin` or `volunteer` profile.

There is real, verified strength underneath all of this, and it should be said plainly. The database layer is genuinely sound: 23 migrations replay cleanly from an empty database, and **81 of 81** DB tests pass — concurrency, seat-limit serialization, FCFS ordering, least-privilege grants, the SMS ledger's claim/complete lease, and RLS boundaries all hold under a real Postgres. Those 81 tests had been skipped in *every* prior evidence report ("local Postgres not available"); this is the first time they have been run. The SQL is not the problem. The browser is.

## Solution

Four things, in order.

**First, restore hydration.** Remove `'strict-dynamic'` from `script-src`, keeping `'self'` and the per-request nonce. Same-origin chunks load again whether or not Next.js managed to inject a nonce into a partially-prerendered shell, and inline and third-party script injection remain blocked. This is a one-directive change; the alternative — forcing every route dynamic with `await connection()` to make nonces universally available — was rejected because it disables partial prerendering across the app, converts every page to a per-request server render, and invalidates every JS route budget and latency figure in the existing evidence, on the eve of a deploy.

**Second, make the gate include the browser.** `npm run verify` becomes lint → unit → db → build → js-budget → e2e. The browser suite stops being a thing someone remembers to run. A red Playwright run fails the gate. `tsc --noEmit` clean becomes part of lint.

**Third, tell the truth about deployment.** One document is the authority on environment variables, generated from and checked against the names the code actually reads. `CRON_SECRET` is required for the reminder job and its absence is reported by readiness rather than discovered by silence. The dead invite codes are removed from the production environment.

**Fourth, build Aadhaar eKYC self-registration behind a provider adapter, shipped dark.** A patient verifies their identity with an Aadhaar eKYC OTP, confirms the demographics UIDAI returns, picks an open Camp Day, and receives a registration number plus a status link on screen. When no provider is configured — which is the state on the day this ships — the route is disabled and the page says so, so the feature carries no production risk until Digio or Decentro credentials are added.

## User Stories

### Hydration and the browser gate

1. As a volunteer, I want the sign-in form to actually sign me in, so that I can open the desk at all.
2. As a volunteer, I want the QR scanner to start when I tap Scan, so that I can check patients in.
3. As a doctor, I want Mark seen to record the consultation, so that the queue advances.
4. As an admin, I want the seat board and queue to update, so that the numbers on screen mean something.
5. As a member of camp crew, I want every interactive control on every page to respond, so that the app is usable rather than merely visible.
6. As an operator, I want one command that tells me whether the branch is shippable, and I want it to fail when the browser suite fails, so that a dead client bundle cannot be reported as green.
7. As a developer, I want a test that asserts the page actually hydrated, so that a CSP or bundling regression is caught by the gate rather than by a camp worker.
8. As a developer, I want `tsc --noEmit` to be clean and enforced, so that a type error outside the Next.js module graph cannot sit on the branch.
9. As a reviewer, I want closure evidence to include the literal output of the browser suite, so that "e2e PASS" is a fact rather than a claim.
10. As an operator, I want the production CSP to still block inline and third-party scripts after the fix, so that restoring hydration does not cost the protection the nonce was introduced for.

### Deployment configuration truth

11. As an operator, I want a single authoritative list of environment variables that matches the names the code reads, so that following the deployment guide produces a working system.
12. As an operator, I want the nightly reminder job to report loudly when it is unauthorised, so that a missing secret is visible on day one rather than after a camp.
13. As an operator, I want readiness to tell me which optional integrations are unconfigured, so that "SMS is off" is a stated fact rather than an inference from silence.
14. As a security reviewer, I want no unused secret to remain in the production environment, so that the retired signup flow leaves no credential behind.
15. As an operator, I want the cron secret compared in constant time, so that the endpoint does not leak its secret through response timing.
16. As an operator, I want the public status page rate-limited, so that an unauthenticated loop cannot drive database cost.

### Patient status page

17. As a patient, I want my queue position to update while I watch the page, so that the number I am looking at is current.
18. As a patient on a weak connection, I want the status page to stay fast and text-first, so that it loads in a hall with poor signal.
19. As a patient, I want the page to keep working with no JavaScript at all, so that an old handset still shows my position.

### Aadhaar eKYC self-registration

20. As a patient at home, I want to register myself for a camp day, so that I do not have to queue at the desk to be recorded.
21. As a patient, I want to verify my identity with my Aadhaar and the OTP UIDAI sends me, so that my registration is trusted without a staff member vouching for me.
22. As a patient, I want my name, age, gender and address filled in from my Aadhaar, so that I do not type them on a phone keypad.
23. As a patient, I want to see the details Aadhaar returned and confirm them rather than retype them, so that the record matches my official identity.
24. As a patient, I want to choose from the camp days that still have seats, so that I am not offered a day that is full.
25. As a patient, I want my registration number shown large on screen when I finish, so that I can note it down without a printer.
26. As a patient, I want a status link I can reopen later, so that I can check my queue position on camp day.
27. As a patient who self-registered, I want to still be checked in at the desk when I arrive, so that my queue position reflects when I actually got there.
28. As a patient, I want to be told clearly when self-registration is unavailable, so that I go to the desk instead of retrying a dead form.
29. As a patient whose Aadhaar OTP fails, I want a plain reason and a retry, so that a mistyped digit is recoverable.
30. As a patient whose Aadhaar is already registered for this camp, I want to be told my existing registration number, so that I do not create a duplicate.
31. As a patient who shares a phone with my family, I want to be told to use the desk when the system cannot safely tell us apart, so that nobody's record is silently overwritten.

### Queue integrity under self-registration

32. As a volunteer, I want a self-registered patient to arrive as `registered` and not `waiting`, so that the FCFS Queue only contains people who are physically present.
33. As a volunteer, I want the seat-board `waiting` count to remain a count of people in the hall, so that I can trust it when calling patients.
34. As an operator, I want self-registration to consume a Camp Day seat under the same row lock as desk registration, so that overbooking stays impossible.
35. As an operator, I want at most one self-registration per verified Aadhaar per Camp, so that the public path cannot be used to exhaust seats.
36. As an operator, I want the OTP and registration endpoints rate-limited by IP and by identity, so that a script cannot hammer the provider or the database.
37. As a member of staff, I want a self-registered patient to be indistinguishable from a desk-registered one at check-in, so that I learn no new procedure.

### Aadhaar verification provenance

38. As a member of staff, I want to see whether a patient's identity was Aadhaar-verified, so that I know how much to trust the record in front of me.
39. As a member of staff, I want to verify a walk-in's Aadhaar when it would help, so that I can resolve a doubtful identity at the desk.
40. As a volunteer at a busy desk, I want Aadhaar verification to stay optional for walk-ins, so that a third-party API outage never blocks the queue.
41. As a security reviewer, I want the full Aadhaar number never to be persisted, so that the database is not an Aadhaar data store.
42. As an operator, I want a provider reference recorded for each verification, so that a disputed record can be traced back to the provider.
43. As a developer, I want the Aadhaar provider behind one interface with a mock implementation, so that the whole flow is testable before any provider contract is signed.
44. As an operator, I want to switch from Digio to Decentro by changing configuration, so that the choice of provider is not baked into the codebase.
45. As an operator, I want the eKYC flow to fail closed when the provider is unconfigured, so that shipping the feature dark carries no risk.

## Implementation Decisions

Everything below is **decided**. Executor agents implement it as written. Where an alternative was considered and rejected, the reason is given so the decision is not silently re-litigated.

### D1 — Remove `'strict-dynamic'`; keep `'self'` and the nonce

The CSP builder drops `'strict-dynamic'` from `script-src` in both development and production. `'self'` and `'nonce-…'` stay. Development keeps `'unsafe-eval'`.

The nonce is retained deliberately even though `'self'` now does the load-bearing work: Next.js still applies it to inline scripts and styles it generates on dynamically-rendered routes, and it costs nothing.

**Rejected:** forcing every route dynamic with `await connection()` so nonces are always injected. It disables partial prerendering app-wide, makes every page a per-request server render, and invalidates every JS route budget and latency measurement already recorded. Too large a change to make on the eve of a deploy, in service of a directive whose benefit here is marginal — the app loads no third-party scripts.

**Rejected:** dropping the nonce entirely and relying on `'self'` alone. It discards the inline-script protection #13 was built to obtain.

The regression guard is behavioural and browser-level: assert in the browser that the framework runtime is present and React has hydrated, **and** that the served `script-src` contains neither `'unsafe-inline'` nor `'strict-dynamic'`. A test that only greps the CSP string would have passed throughout this failure.

### D2 — The gate includes the browser and the type checker

`npm run verify` becomes, in one run and in this order: lint → `tsc --noEmit` → unit → db → build → js-budget → e2e.

The database step is included because the 81 DB tests were skipped in every prior evidence report while being cited as passing. They require Docker; when Docker is genuinely unavailable the step must **fail loudly with a named blocker**, never skip silently into a green run.

A ticket is closed only when its closing comment contains the literal terminal output of `npm run verify`, including the e2e summary line. A ticket whose evidence is `npm test` alone is not closed.

**Rejected:** keeping e2e as a separate opt-in command for speed. That is the arrangement that let a whole-app hydration failure be reported as production-ready.

### D3 — Fix the type error in the e2e route handler

`e2e/a4-batch.spec.ts` refers to a `Route` type it never imports. Import the type from `@playwright/test` rather than widening the parameter to `any` or removing the annotation — the annotation is load-bearing documentation for a route-interception callback.

### D4 — One authoritative environment document, generated against the code

`.env.example` is the single authority for variable names. A checked script asserts that every `process.env.X` read in `src/` and `scripts/` appears in `.env.example`, and fails the gate on drift. The handoff report's incorrect MSG91 names are corrected wherever they appear in committed documentation.

`CRON_SECRET` is required for the reminder job. Readiness reports the configuration state of each optional integration — SMS, Aadhaar eKYC, cron — as explicit booleans, so "off" is a stated fact. Readiness must **not** fail on an unconfigured optional integration; the camp runs without SMS by design.

`ADMIN_INVITE_CODE` and `VOLUNTEER_INVITE_CODE` are removed from the production environment. No code reads them.

### D5 — Cron authorisation is constant-time

Compare the bearer token with a length-independent constant-time comparison. Reject before comparison when the configured secret is absent, and log that the job was called while unconfigured so the condition is visible.

### D6 — The public status page is rate-limited and refreshes itself

The status route gets an IP-scoped rate limit through the existing limiter. Token-scoped limiting is deliberately **not** added: the token is the only identifier a legitimate patient has, and limiting on it would let one shared handset lock a family out of their own status.

The page refreshes with `<meta http-equiv="refresh" content="30">`. Zero client JavaScript is preserved — that is why this page renders on a weak connection and why its CSP surface is trivial. A 30-second full reload is adequate for a queue that moves in minutes.

**Rejected:** a small client polling island. It puts JavaScript on the one route that deliberately has none and adds a bundle budget to a 193 kB route.

### D7 — Identity for self-registration is Aadhaar eKYC OTP only

One verification step. The patient submits a 12-digit Aadhaar number; the provider initiates eKYC and UIDAI sends an OTP to the Aadhaar-linked mobile; the patient enters the OTP; the provider returns demographics. Possession of the Aadhaar-linked mobile is proven by the OTP, so there is no separate phone-OTP gate.

**Rejected:** a separate phone OTP in addition to the Aadhaar OTP. It verifies a number the Aadhaar OTP already proves possession of, at the cost of a second step and measurable drop-off.

### D8 — The contact number is the Aadhaar-linked number, and is not editable

The phone recorded on a self-registration is the number the eKYC OTP was delivered to. The patient cannot change it in the self-service flow. This guarantees that registration and reminder SMS reach a number the patient demonstrably controls.

The consequence is accepted and must be stated in the UI: a patient whose Aadhaar carries a number they no longer use will not receive camp SMS, and their remedy is the desk. The success screen therefore always shows the status link and registration number on screen, never relying on SMS to deliver them.

Staff **can** change a patient's phone afterwards through the existing desk path. Self-service cannot.

### D9 — eKYC demographics are confirmed, not retyped

Name, age, gender and address are rendered read-only from the eKYC response. The patient confirms them. The only inputs in the self-service form are the Camp Day choice and the confirmation action.

This makes "Aadhaar verified" mean the stored record matches what UIDAI returned. A patient who needs a correction goes to the desk, where staff can edit freely.

**Rejected:** prefilled-but-editable fields. It is more forgiving of transliterated names and stale addresses, but it makes the verified badge meaningless, and staff are going to rely on that badge.

Where eKYC returns no usable age but a date of birth, age is derived with the existing helper. Where it returns neither, the registration cannot proceed self-service and the patient is directed to the desk — age is required for the soft-duplicate check.

### D10 — Self-registration writes through a server route as `service_role`

A server route handler holds the eKYC session, verifies it server-side, and calls the registration RPC with the service-role client. No grant is widened, no RLS policy changes, and no patient ever holds a Supabase session. The RPC's existing `service_role` branch already refuses both duplicate overrides, which is exactly the required behaviour for a self-service caller.

`created_by` is null on a self-registration: no staff member created it.

**Rejected:** minting an `authenticated` session for the patient. It reopens the patient-Auth capability model that #59 deliberately retired and would require re-auditing every RLS policy that assumes `authenticated` means camp crew.

**Rejected:** a new patient-scoped database role. A new privilege surface to audit and extend across the readiness grant expectations, for no behaviour the service-role path does not already provide.

### D11 — Self-registration never checks the patient in

The registration RPC gains a `p_self_service` boolean, defaulting false. When true:

- Queue status is **always** `registered`, `queued_at` and `checked_in_by` are null, regardless of whether the chosen Camp Day is today. The walk-in branch is suppressed entirely.
- Both duplicate overrides are refused, reinforcing the `service_role` rule.

This preserves the invariant `CONTEXT.md` states explicitly: `waiting` means physically present, and the FCFS Queue is ordered by check-in time. A patient registering from their sofa for today must not hold a queue position ahead of someone standing in the hall.

The patient is checked in at the desk on arrival through the unchanged `check_in_patient` path — by name search, registration number, or the QR on their status page. Staff learn no new procedure.

**Rejected:** letting the existing walk-in branch apply. It is the single most damaging thing this feature could do to the product, because it corrupts the ordering the whole queue is built on and it does so invisibly.

### D12 — One self-registration per verified Aadhaar per Camp

The full Aadhaar number is never persisted. Uniqueness is enforced on a keyed hash: `HMAC-SHA256(aadhaar_digits, pepper)`, computed in the server route, stored on the patient row as `aadhaar_hash`. A unique index scoped to `(camp_id, aadhaar_hash)` covers self-service rows only, so desk registrations are unaffected.

The pepper is a required environment variable for self-registration. When it is absent, self-registration is disabled — fail closed. The pepper must never be rotated while a camp is active; rotation invalidates the uniqueness guarantee for existing rows.

A repeat attempt returns the patient's **existing** registration number and status link rather than an error. Re-registering is not a failure; it is a patient checking on themselves.

**Rejected:** using the locked phone number as the uniqueness key. A household can share one Aadhaar-linked mobile across several Aadhaars, and that would wrongly block the second family member.

### D13 — Soft and hard duplicates send a self-service patient to the desk

The existing `LIKELY_DUPLICATE` (normalised name + age, or phone, within the active Camp) and `AADHAAR_DUPLICATE` (Aadhaar last-4 + normalised name) checks apply unchanged. A self-service caller cannot override either.

On `LIKELY_DUPLICATE`, the page shows one Hinglish sentence naming the conflicting registration number and directs the patient to the desk. On `AADHAAR_DUPLICATE`, the same. Neither is presented as an error the patient did something wrong.

Because Aadhaar last-4 is required for self-registration (D14) and households commonly share a phone, this path will fire for real families. That is accepted: the desk is where a human resolves ambiguity, and staff already hold the override with attribution.

**Rejected:** granting self-service an override for the phone leg. It hands duplicate-approval authority to the public, which is the precise thing the override audit trail exists to prevent.

**Rejected:** skipping the phone leg for self-service. It would let the same person register twice with no warning.

### D14 — Aadhaar last-4 is required for self-registration and stays optional at the desk

Self-service always has a verified Aadhaar, so the last-4 is always available and always stored. The hard duplicate check therefore always has something to bite on for this path.

The desk keeps Aadhaar as optional. A walk-in without their card must still be registerable in seconds.

### D15 — One provider adapter, a mock, and two named stubs

A single module owns the Aadhaar eKYC contract, in the shape the existing MSG91 module established — one module, one interface, provider swap is an edit to that file plus configuration.

The interface is two operations:

```ts
type AadhaarKycProvider = {
  // Sends the Aadhaar number to the provider; UIDAI OTPs the linked mobile.
  initiateKyc(aadhaarDigits: string): Promise<
    | { ok: true; txnId: string; maskedMobile: string | null }
    | { ok: false; detail: string; failureKind: "rejected" | "uncertain" }
  >;
  // Exchanges the OTP for demographics. Never returns the Aadhaar number.
  verifyOtp(txnId: string, otp: string): Promise<
    | { ok: true; profile: AadhaarProfile; providerRef: string; phone: string | null }
    | { ok: false; detail: string; failureKind: "rejected" | "uncertain" | "expired" }
  >;
};
```

`AadhaarProfile` already exists and already carries exactly the fields eKYC returns — full name, gender, age, address, phone, email. Reuse it; do not introduce a parallel type.

Three implementations ship: a **mock** provider that drives the complete flow deterministically and is what the test suite exercises; a **Digio** adapter and a **Decentro** adapter, each complete except for the live endpoint path and credentials. Selection is by configuration. Unknown or unset selection means unconfigured, which means the feature is off.

The `failureKind` distinction mirrors the SMS module's: `rejected` is a provider verdict and terminal; `uncertain` is a timeout or network drop and may be retried; `expired` means the OTP window closed and the patient must restart.

**Rejected:** extending the existing generic `AADHAAR_LOOKUP_URL` webhook to carry an OTP round-trip. The Digio/Decentro shape differences have to be absorbed somewhere; putting them in a separate service the operator also has to run and monitor is strictly worse than a file in this repository.

**Rejected:** implementing Digio directly. Both providers were named, so the choice is not settled, and an unabstracted integration is the expensive thing to undo.

### D16 — eKYC transaction state is server-side and short-lived

The `txnId` returned by `initiateKyc` is held server-side, keyed to a short-lived opaque handle given to the browser. The Aadhaar number is used to compute the hash and the last-4, then discarded — it is never written to storage, never logged, and never returned to the client.

The handle expires on a bounded window consistent with UIDAI OTP validity. An expired handle produces a restart, not a partial registration.

The OTP verify endpoint is rate-limited by IP and by handle. `initiateKyc` is rate-limited by IP.

### D17 — Verification provenance on the patient row

Three additions to the patient row:

- `aadhaar_verified_at` — timestamp, null when identity was not eKYC-verified.
- `aadhaar_kyc_ref` — the provider reference for the verification, for tracing a disputed record.
- `aadhaar_hash` — the keyed hash from D12.

The full Aadhaar number is not among them and must never be.

The desk shows a "Aadhaar verified" indicator derived from `aadhaar_verified_at`. Null means self-declared, which is the normal state for a walk-in and must not read as a warning.

### D18 — The desk gets optional eKYC through the same adapter

Staff gain a Verify Aadhaar action on the desk registration form, using the identical provider adapter. On success it fills the form and stamps the verification columns. Registration never requires it and never blocks on it.

The existing `/api/aadhaar-lookup` demographic-fetch route is retired in favour of the adapter. It performs an unverified lookup — the number in, a profile out — which is not verification and should not be presented alongside a flow that is.

### D19 — Self-registration is off until a provider is configured

With no provider configured — the state on the day this ships — the self-registration route returns unavailable and the entry point renders a plain message directing the patient to the desk. The public home page does not advertise a path that cannot complete.

Readiness reports the eKYC configuration state as a boolean fact. It does **not** fail when eKYC is unconfigured.

This is what makes the feature safe to merge before any provider contract exists.

### D20 — Reuse the registration SMS ledger unchanged

A self-registration with a phone enqueues a pending row in the existing `sms_deliveries` ledger exactly as a desk registration does. When MSG91 is wired later, self-registrations are covered with no further work. No new notification code.

## Testing Decisions

### What makes a good test here

A good test fails when the product breaks and passes when it does not. It asserts on observable behaviour: a response body, a status code, a redirect, a rendered role or region name, the payload a module sends, the value a reducer returns, the presence of a hydrated framework runtime in a real browser. It does not assert on the text of the source that produces that behaviour.

This batch exists because a test that greps a CSP string passed while the CSP it was grepping made the application inert. **The lesson is specific: assert the effect, not the configuration.** A CSP test must prove the page hydrated. A cron-auth test must prove a request is rejected. A migration test must prove the RPC behaves, not that a file contains a keyword.

### Seams — five existing, zero new

1. **`node:test` behaviour suite (`tests/*.test.mjs`)** — pure modules and route handlers driven with mocked Supabase clients and mocked `fetch`. Prior art: `tests/registration-request.test.mjs`, `tests/msg91.test.mjs`, `tests/sms-delivery.test.mjs`.
2. **DB suite against real Postgres (`tests/*.db.test.mjs`)** — RPC behaviour, RLS, grants, concurrency. Prior art: `tests/camp-day-capacity-concurrency.db.test.mjs`, `tests/likely-duplicate-concurrency.db.test.mjs`. This seam is now part of the gate.
3. **Playwright browser suite (`e2e/*.spec.ts`)** — real auth, real database, disposable labelled fixtures. This is where hydration, camera teardown, focus management and print geometry are proven. Prior art: `e2e/roles.spec.ts`, `e2e/csp.spec.ts`.
4. **`npm run check:js-budget`** — gzipped initial JS per route.
5. **`GET /api/health?ready=1`** — catalog and migration-head contract.

No new seam is added. The mock eKYC provider is not a seam; it is a test double inside seam 1.

### What gets tested, per area

- **Hydration** — in a real browser, against a production build: the framework runtime is present, React has hydrated, a client-only interaction produces its effect, and the served `script-src` contains neither `'unsafe-inline'` nor `'strict-dynamic'`. This test must be shown to fail with `'strict-dynamic'` restored.
- **Sign-in** — all three staff roles reach their desk in a real browser. This is the assertion that was failing for all 31 tests and it is the canary for the whole class.
- **CSP builder** — unit tests on the returned directive string for both environments, as a fast complement to the browser proof, never as a substitute.
- **eKYC provider adapter** — against the mock: initiate returns a handle; verify exchanges OTP for demographics; `rejected` is terminal; `uncertain` is retryable; `expired` forces restart; the Aadhaar number appears in no return value and no log line.
- **Self-registration route handler** — unconfigured provider returns unavailable; a verified handle registers; queue status is `registered` even when the chosen day is today; `created_by` is null; the phone equals the eKYC-delivered number; a repeat with the same Aadhaar returns the original registration number; both duplicate codes surface as desk-referral rather than override.
- **`p_self_service` in the RPC** — against real Postgres: today's Camp Day yields `registered` and null `queued_at`; both override parameters raise; the seat lock and seat limit behave identically to the desk path; N concurrent self-registrations against M seats yield exactly M successes.
- **Per-camp Aadhaar uniqueness** — two self-registrations with the same Aadhaar in one Camp produce one row and two successful responses returning the same registration number; the same Aadhaar in a different Camp registers normally; a desk registration is unaffected by the index.
- **Verification columns** — `aadhaar_verified_at`, `aadhaar_kyc_ref` and `aadhaar_hash` are set on a verified registration and null on a desk registration without verification; no column anywhere holds twelve Aadhaar digits.
- **Cron authorisation** — a correct bearer is accepted, a wrong one and an absent secret are rejected, and the comparison is constant-time.
- **Environment drift** — the generated check fails when a `process.env` read has no `.env.example` entry.
- **Status page** — the served markup carries the refresh directive; the page renders with JavaScript disabled; the rate limit returns 429 past its threshold.
- **Readiness** — optional-integration booleans are reported truthfully and an unconfigured integration does not make readiness fail.
- **Bundle budget** — the self-registration route declares and meets a budget.

### Coverage reporting rule

Any change that deletes tests states what is no longer covered. A rising pass count after a deletion is close to tautology and must never be offered as evidence of health on its own.

Additionally, and specific to this batch: **a skipped test is not a passing test.** The 81 DB tests were cited as passing in nineteen closure reports while being skipped in every one of them. Any suite that skips must report the skip count in the closing comment, and a skip caused by a missing local dependency is a named blocker, not a pass.

## Out of Scope

- Live MSG91 SMS delivery against a real handset. The ledger, templates and cron are built and tested; wiring the provider credentials is a separate, later step and the honest readiness signal is the configuration boolean.
- Live Digio or Decentro integration. The adapters are built to the point where only the endpoint and credentials are missing. Signing a provider contract and exercising a real UIDAI OTP is out of scope.
- Physical camera QR trials — blur, lighting, distance, real device timing.
- Any patient-facing Supabase Auth session. Patients do not authenticate; #59 stands.
- Editing a self-registered patient's phone in the self-service flow. Staff do this at the desk.
- Aadhaar offline XML, QR-code Aadhaar, or DigiLocker document fetch. Online OTP eKYC only.
- Applying any production migration without explicit human sign-off recorded on the ticket.
- Restyling the operational desks.
- Rewriting the queue as websocket-first. The poll is the freshness owner.

## Further Notes

### What was verified this session, and how

Run against `fix/gate-a-56-57-58` at `88e52d3`:

- `npx supabase db reset --yes` — 23 migrations replay cleanly from an empty database.
- `npm run test:db` — **81 pass, 0 fail, 0 skip** against real Postgres. First time these have been executed; they were skipped in every prior evidence report.
- `npm test` — 280 pass, 0 fail, 88 skip.
- `npm run lint` — 0 errors, 17 warnings (all unused imports in the two `empirical-challenge-*` test files added during the adversarial review).
- `npm run build` — succeeds, 22 routes.
- `npx tsc --noEmit` — **one error**, `e2e/a4-batch.spec.ts:240`.
- `npm run test:e2e` — **31 failed, 4 passed**, all failures downstream of `loginStaff`.
- Direct browser inspection of `next start`: 11 script tags, **0 nonces**, `window.__next_f` undefined, all chunk requests failed, CSP `script-src 'self' 'nonce-…' 'strict-dynamic'`.

### On the closure evidence for #64, #69 and #72

Those tickets were closed citing passing Playwright runs — "Playwright accessibility suite PASS", "E2E visual & PDF artifact verification PASS", "`npm test` PASS (280/280)". The browser suite does not reproduce those results on this commit; 31 of 35 tests fail, including every a11y, print-geometry and batch test named in that evidence. The DB-test claims in the same matrix cited suites that were skipping.

The technical work in those tickets may well be correct — the DB layer certainly is, and it is genuinely good. What is not established is that it was ever verified in a browser. The tickets are being commented on rather than silently superseded, so the record stops asserting something that cannot be reproduced.

### On the pattern

The diagnosis in `SPEC_REMAINING_HARDENING.md` was right and it recurred: *work was declared done one step before the step that proves it.* Here the missing step was the one the previous spec named as the highest seam in the codebase — the browser suite — and the failure mode was worse than before, because a passing `verify` actively vouched for a build in which nothing worked.

The gate change in D2 exists to make that impossible rather than to ask for more care.

### Sequencing

D1 blocks everything. Until hydration is restored, no browser test can pass and no other change in this batch can be verified. D2 lands with it, because a gate that cannot see the browser is how this happened.

D3, D4, D5, D6 are independent and can proceed in parallel.

The Aadhaar work has an internal order: D15 (adapter and mock) before D16 (session), before D10/D11/D12 (the write path), before D9/D19 (the UI). D17's columns come with D11's migration. D18 and D20 are last and small.

### One thing not to lose

The database layer is the strongest part of this codebase and it is now properly proven. Whatever happens to the front end, do not let a schema change land without `npm run test:db` green against a clean replay. Those 81 tests are the reason overbooking, queue ordering and least-privilege reads can be trusted, and they were one report away from never having been run at all.
