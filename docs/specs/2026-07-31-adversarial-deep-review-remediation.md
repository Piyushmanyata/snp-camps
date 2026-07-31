# Spec: Adversarial deep review remediation (2026-07-31)

**Source:** Full-repo adversarial review via graphify (1657 nodes / 3212 edges), lean-ctx line review, and five parallel specialist subagents (security, API/desk, domain/clinical, performance/CodSpeed-style, frontend/a11y).  
**CodeRabbit CLI / CodSpeed CLI:** not installed in this environment — review style applied manually.  
**Repo:** `Piyushmanyata/snp-camps` @ `main` (`230648c` and prior).

---

## Problem Statement

Camp day operations depend on this app for registration, printing/queueing, clinical fulfilment, and patient status. A full-codebase adversarial review found **correctness bugs that violate written domain rules** (seat caps on walk-ins, dead duplicate overrides, wrong Team Lead KPIs, false “printed” flash), **security/privacy gaps** (status token returned from manual registration RPC, weak public recovery factors, self-reg abuse surface), and **field-reliability / performance defects** (clinical QR scanner full-res main-thread decode, self-reg double-submit races, login Suspense shell posting natively).

Operators and patients cannot safely trust every path under load, full camp days, network flakes, or adversarial clients until these are fixed in priority order.

---

## Solution

Ship a phased remediation that:

1. Restores **domain invariants** from CONTEXT.md / ADRs (seat caps pre-reg only; print-for-duplicate; KPI labels; language surfaces).
2. Closes **token and abuse holes** without rewriting the product model (narrow RPC projections; stronger self-reg controls; dedicated rate-limit secret).
3. Makes **desk and clinical cameras** share the hardened QR session stack.
4. Aligns **API contracts** (validation parity, status codes, idempotency keys, public-error mapping).
5. Adds **performance guards** (decode benches / bounds; FCFS index alignment; poll cost trim) so field phones stay usable.

No greenfield rewrite. Prefer smallest correct change per finding; keep existing SECURITY DEFINER RPC + RLS posture.

---

## User Stories

### Domain & desk operations

1. As a walk-in patient standing at the desk on a full camp day, I want to still be registered, so that seat caps never turn away someone already in the hall.
2. As a volunteer, I want full camp days still selectable for **today** walk-ins, so that the form matches the database rule.
3. As a volunteer facing a likely-duplicate warning, I want **Print for them instead** to actually print and queue the existing registration, so that the paper and FCFS line stay consistent.
4. As a volunteer facing a likely-duplicate warning, I want honest flash copy (no claim of print when only check-in ran), so that I trust the desk.
5. As a volunteer with a hard Aadhaar last-4+name conflict, I want an audited **override once** path that actually reaches the server (or no override UI at all), so that I am not stuck in a loop.
6. As a Team Lead, I want my desk KPI island to show **team rollup**, not only my personal volunteer metrics, so that I can manage capacity.
7. As a volunteer, I want KPI labels to match original-registrar credit (Registered / Seen), not “handled / today / in queue” zeros, so that leaderboard trust holds.
8. As Registration Staff, I want all desk validation and flash strings in **English**, so that language rules are not broken.
9. As a patient on self-registration, I want Hinglish only on patient surfaces, so that audiences never mix.
10. As a volunteer, I want exhausted retry copy for mark-seen/undo to say the right action (not “assign”), so that recovery is clear.

### Security & privacy

11. As a patient, I want my status token never returned in staff API payloads that can be logged in DevTools, so that bearer links stay scarce.
12. As ops, I want manual exception RPC to return a narrow projection (id, reg_no, day, status), never `SELECT *` including `status_token`.
13. As a security owner, I want public lookup beyond reg_no+DOB strengthened or hardened (lockout/CAPTCHA/extra factor), so that status links are not cheap to recover.
14. As ops, I want self-registration abuse limited (CAPTCHA and/or tighter durable quotas), so that seat pollution and forged Persons are harder.
15. As ops, I want a dedicated `RATE_LIMIT_SECRET` (no service-role fallback), so that secrets stay separated.
16. As a patient, I want `/s/[token]` protected by multi-instance rate limits under load, so that DoS is harder across serverless instances.
17. As staff, I want notify/SMS routes rate-limited per user and free of raw provider error text in JSON, so that spend and leaks are bounded.
18. As a developer, I want rate-limit client IP to trust only platform-injected headers on Vercel, so that spoofed XFF cannot empty buckets.

### Self-registration & lookup

19. As a patient on a flaky mobile network, I want a stable `requestId` so retries do not mint conflicting outcomes.
20. As a patient re-scanning the same Aadhaar card, I want my **existing registration number and status link** back (CONTEXT), not only a desk referral without a link.
21. As a patient, I want household phone rules (6–9 start, reject dummy repeats) on self-reg, same as the desk.
22. As a patient, I want gender restricted to M/F/O and age bounds matching desk scanned registration, so Person keys stay consistent.
23. As a patient using lookup, I want 429 responses to include Retry-After even on the in-memory gate, so clients back off correctly.
24. As a patient, I want the status URL on the receipt to be same-origin `/s/<token>` only, so open redirects cannot spoof the receipt.

### Clinical desk

25. As a Clinical Desk Operator, I want Patient QR deep links (`/p/{id}` / `snp:`) to open Clinical Desk, so I am not forced to type reg numbers.
26. As a Clinical Desk Operator, I want the patient QR camera to use the hardened desk decode stack (bounded surface, session lifecycle), so mid-range phones do not freeze.
27. As an admin on Clinical Desk, I want either full mutation rights with audit **or** mutation controls hidden, so Save/Resolve are never dead ends.
28. As a Clinical Desk Operator, I want fulfilment resolve disabled until a transcription exists, so errors are not confusing.
29. As a Clinical Desk Operator, I want diagnosis capture that does not split on commas, so “Other” text is not corrupted.
30. As a Clinical Desk Operator, I want slip replace via an accessible modal (not three `window.prompt`s), so keyboard and mobile work.

### Frontend reliability & a11y

31. As staff on a slow network, I want the login Suspense shell **not** to be a native POST form, so credentials never navigate away unhandled.
32. As a patient self-registering, I want double-submit and “Dobara scan” disabled while a request is in flight, so races cannot create two rows or wrong receipts.
33. As a patient on lookup, I want loading state cleared even when navigation fails, so the form never sticks.
34. As staff, I want toasts that stay visible when the message changes quickly, so mark-seen feedback is readable.
35. As staff with Aadhaar lock, I want locked gender to be truly non-interactive (disabled/static), so I do not think I changed it.
36. As a keyboard user, I want visible focus on all controls (including clinical selects), so global outline removal does not hide focus.
37. As an admin, I want letterhead URLs allowlisted like sponsor logos, so external images cannot be injected into print templates.
38. As any user, I want a root `global-error.tsx` recovery UI if the root layout crashes.

### Performance (CodSpeed-style)

39. As a clinical station on a budget phone, I want no full-resolution main-thread jsQR every frame, so the UI stays interactive.
40. As a desk on Windows Chrome (jsQR path), I want optional worker-based decode so the main thread is free for React.
41. As a developer, I want decode surface bounds and Secure QR numeric→bytes benches, so multi-second freezes cannot regress silently.
42. As ops at multi-desk scale, I want desk-live polls to avoid unnecessary exact counts / work when possible, so DB load stays flat.
43. As a DBA, I want the waiting partial index ordered as FCFS (`queued_at, reg_no, id`), so large queues sort cheaply.
44. As a public API, I want rate-limit prune work amortized (not full DELETE every consume), so write amplification stays low.

### Documentation & governance

45. As a future agent, I want ADR 0005 amended to original-registrar-only KPIs (issue-124), so docs do not contradict code.
46. As a future agent, I want CONTEXT name-search updated for all-status desk search, so recovery design is explicit.

---

## Implementation Decisions

### Phase A — Critical domain correctness (camp day blockers)

1. **Seat caps pre-reg only**
   - In `register_patient_idempotent` (and any successor bodies): enforce `seat_limit` only when `p_self_service` is true **or** the chosen day is not “today” Asia/Kolkata walk-in desk path per CONTEXT.
   - Desk UI: do not hard-block today walk-in selection solely because `is_full`; keep self-register / future-day full-day blocking.
   - Prefer one SQL rule of truth; UI mirrors it.

2. **Likely-duplicate primary action = print + queue**
   - “Print for them instead” must open/print path (`mark_patient_printed` / print route + auto print) for the **existing** patient id, not only `check_in` without paper.
   - English staff copy; truth-based flash.

3. **Scanned-path duplicate overrides**
   - Product decision (pick one, implement fully):
     - **A (preferred if CONTEXT stands):** audited one-shot overrides on scanned API for staff only, server-side flags + audit columns; never accept client-forged Person keys.
     - **B:** remove override UI; only “print existing” / desk referral.
   - Today: UI sets overrides; scanned route forces both override flags false → dead loop. Must resolve.

4. **Team Lead KPI section**
   - `/api/desk/section` / `loadSection` for volunteer-kpis: pass `team_lead` when profile role is team lead so `staff_person_kpis` rolls up the team.
   - Volunteer KPI strip labels: map to original-registrar Registered / Seen; drop misleading “handled / today / in queue” zeros.

### Phase B — Token & abuse hardening

5. **Manual exception RPC projection**
   - Stop `return query select * from patients`. Return the same narrow columns as successful scanned registration (no `status_token`).
   - Audit other `SETOF patients` / `SELECT *` staff RPCs for the same leak class.

6. **Self-registration**
   - Accept client-stable `requestId` (UUID) for idempotency.
   - Same-Person re-scan: return existing reg + status link (safe service-role RPC), matching CONTEXT.
   - Reuse `validateHouseholdPhone`; gender `M|F|O`; age bounds aligned with desk.
   - Abuse: CAPTCHA/Turnstile and/or tighter distributed limits; optional hold status URL until desk confirm (product call — default: keep URL but CAPTCHA + quotas first).

7. **Public lookup**
   - Progressive lockout / CAPTCHA after N failures per reg; consider second factor (phone last-4) if product allows.
   - Include Retry-After on in-memory 429.

8. **Rate limit secret**
   - Require `RATE_LIMIT_SECRET`; remove service-role key fallback; fail closed if unset.

9. **Status page**
   - Add distributed rate limit (or CDN/WAF) for `/s/*` in addition to in-memory.

10. **Notify route**
    - Rate limit by staff `userId`; map provider failures through public-error helpers; 401 vs 403 split.

### Phase C — Clinical & camera reliability

11. Replace `PatientQrCamera` usage in Clinical Desk with shared `QrScanner` / `QrCameraSession` path (bounded edge, generation tokens, stop tracks). Delete or gut legacy component if unused after.

12. `/p/[id]`: allow `clinical_operator` → redirect to `/clinical` with scan id; keep print/mark-seen denied.

13. Admin clinical UX: either grant admin the same mutation RPCs with audit, or hide Save/Resolve for admin-only sessions.

14. Clinical form: require saved transcription before resolve; diagnosis as structured multi-select + Other text (not comma-split string).

15. Slip replace: modal form with labels/validation instead of `window.prompt` ×3.

### Phase D — Frontend reliability

16. Login static shell: non-submittable skeleton (no `method="post"` without handler).

17. Self-reg flow: `if (busy) return`; disable rescan while busy; generation/AbortController ignore stale responses.

18. Lookup: clear loading in `finally`.

19. Toast: depend on `message` or remount with `key={message}`.

20. Letterhead URL allowlist parity with sponsor assets.

21. Locked gender: disabled/static control.

22. Add `global-error.tsx`.

23. Prefer `loadSessionProfile` in all API routes currently using `getSessionProfile` for consistency (print, admin staff, sponsor assets).

### Phase E — Performance & observability

24. Worker buffer reuse for thorough multipass; faster Secure QR `numericStringToBytes` (chunked, avoid full BigInt).

25. Waiting index alignment: partial index `(camp_id, queued_at, reg_no, id) WHERE queue_status = 'waiting'`.

26. Probabilistic prune in `consume_public_rate_limit`.

27. Desk-live: avoid exact count when under limit; optional payload ETag later.

28. Add timed benches (node:test or CodSpeed Node) for: surface bound, FAST miss, THOROUGH miss, numeric→bytes, desk-live single-flight. Gate CI when CodSpeed auth is available; until then keep assertion-style bounds in unit tests.

### Phase F — Docs

29. Supersede/amend ADR 0005 to original-registrar-only competitive credit.

30. Update CONTEXT name-search bullet for desk all-status search.

### Explicit non-goals in this fix set

- Full UIDAI Secure QR cryptographic verification (ADR 0004 product stance) unless separately decided.
- Replacing bearer status tokens with sessions.
- Realtime (poll-only remains).
- i18n framework.

---

## Testing Decisions

**Good tests** assert external behavior at the highest seam (HTTP route, RPC, Playwright desk flow), not private React state.

### Seams (preferred existing)

| Seam | Use for |
|------|---------|
| `node:test` route tests (`tests/*.route.test.mjs`) | API status codes, override flags, phone validation, Retry-After |
| DB tests (`tests/*.db.test.mjs`) | Seat-cap walk-in, KPI role, status_token projection, clinical eligibility |
| `tests/security-invariants.test.mjs` | No service role in client; token column grants |
| `tests/qr-decode-surface.test.mjs` | Decode edge bound regressions |
| Playwright e2e (`e2e/*`) | Login shell, self-reg busy, clinical scan path, print-for-duplicate |
| `npm run check:js-budget` | No accidental aadhaar-qr / pako eager import |

### Required new / extended cases

1. Desk register today when `is_full` / seat_limit reached → **succeeds** for non-self-service walk-in; self-reg still blocked.
2. Scanned override path matches product decision (A or B) with audit columns.
3. Likely-duplicate primary path hits print/queue and does not claim print without print.
4. Manual exception JSON never contains `status_token`.
5. Self-reg: dummy phone `0000000000` → 400; same card retry with same `requestId` → same reg; re-scan returns status link.
6. Section KPIs as team_lead → RPC `p_role = team_lead`.
7. Clinical operator opening `/p/{uuid}` reaches clinical desk.
8. PatientQrCamera removed or proven to use session + edge cap.
9. Login shell: no document POST without handler (e2e no-js or HTML assert).
10. Performance: surface bound + numeric→bytes timing assertions.

### Prior art

- `desk-register-scanned.route.test.mjs`, `self-registration.route.test.mjs`, `security-invariants.test.mjs`
- `issue-124-clinical.db.test.mjs`, `camp-day-capacity-concurrency.db.test.mjs`
- `qr-decode-surface.test.mjs`, `aadhaar-qr.test.mjs`
- `e2e/roles.spec.ts`, `e2e/register-print.spec.ts`, `e2e/desk-action-timing.spec.ts`

---

## Out of Scope

- Installing/authenticating CodeRabbit CLI or CodSpeed CLI (recommended follow-up; not required to implement this spec).
- Full UIDAI signature verification of Aadhaar Secure QR.
- MFA for staff accounts (recommend separately).
- Hard-deleting clinical PHI / retention policy.
- Redesign of prescription template free-canvas.
- Changing FCFS semantics or adding a fourth queue state.

---

## Further Notes

### Graphify god nodes (high coupling — change carefully)

- `getSessionProfile`, `createClient`, `mapDbError`, `createServiceRoleClient`, `roleHome`

### Severity rollup (from review)

| Severity | Themes |
|----------|--------|
| **Critical** | Walk-in seat-cap block; clinical full-res QR if live (confirmed used by Clinical Desk) |
| **High** | Manual RPC status_token leak; dead scanned overrides; self-reg idempotency/re-scan contract; weak lookup factor; KPI/print-duplicate domain bugs; login shell POST; self-reg race |
| **Medium** | Rate-limit secret fallback; status page in-memory only; notify abuse; validation parity; section 502; team-assignment lead check; language leaks; clinical admin/resolve UX; toast/lookup/letterhead; poll COUNT cost |
| **Low / Info** | Doc drift ADR 0005; pending-removal dead if/else; emoji locks; confirm dialogs; residual CSRF/XSS residual risk |

### Tooling gaps this review worked around

- **CodeRabbit CLI:** not on PATH — adversarial review done by specialist subagents + line-level reads.
- **CodSpeed CLI / MCP:** not authenticated — performance findings are static + complexity/hotspot based; implement benches before claiming measured speedups.

### Suggested agent execution order

1. Phase A (domain) + Phase B items 5–6 (token projection + self-reg contract)  
2. Phase C camera + `/p` routing  
3. Phase D frontend races  
4. Phase B remaining abuse/rate limits  
5. Phase E perf + Phase F docs  

### Local artifact

This file: `docs/specs/2026-07-31-adversarial-deep-review-remediation.md`
