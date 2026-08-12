# Spec: Full-codebase deep-audit remediation

**Date:** 2026-08-03  
**Baseline:** `main` at `721f9f5`  
**Repository:** `Piyushmanyata/snp-camps`  
**Execution target:** Luna (implementation agent)  
**Triage:** Substantial/high-risk because this work touches production-data safety, queue invariants, bearer-link privacy, Auth policy, privileged RPCs, and clinical identity correctness.  
**Execution mode:** Ordered batches with independent review; do not parallel-edit shared registration, rate-limit, clinical-desk, or migration files.

## Project Completion Goal

Make every confirmed defect and explicitly accepted hardening risk in this current-HEAD audit pass green at its highest practical seam, while preserving the three-state queue, append-only migration history, staff-role boundaries, patient Hinglish/staff English boundary, and existing JavaScript budgets.

## Problem Statement

The application compiles and most automated checks pass, but the deep audit found five high-severity failures and a broader set of release, security, reliability, accessibility, and test-governance defects.

The most serious defects are:

1. Database tests may inherit a production `DATABASE_URL` and execute destructive cleanup.
2. Same-day **Register only** places an unprinted patient in the physical FCFS queue, contradicting the accepted queue ADR.
3. A passwordless bearer-link page returns and renders a patient's full name despite an explicit PII-free contract.
4. Overlapping Clinical Desk lookups can replace a newer patient with an older response.
5. Status polling locks out valid patients sharing one NAT/IP and disguises throttling as a 404.

The repository also has two red release gates: `/self-register` exceeds its gzip budget by 1,222 bytes, and the Playwright suite contains one deterministic no-JavaScript timeout plus a polling-page `networkidle` flake. The remaining findings are concrete cross-layer defects or documented privacy/operational hardening work. This spec supersedes the unresolved, choice-heavy portions of issue #125 for the current baseline; it does not re-open findings already fixed in commits after that review.

## Solution

Execute six strictly ordered batches:

1. Make test and migration execution safe and deterministic.
2. Restore queue, status privacy, Clinical Desk identity, and status-rate-limit invariants.
3. Close privileged database/Auth/readiness gaps.
4. Repair registration, scanning, staff provisioning, and sponsor-asset transactions.
5. Repair release performance, staff KPI truth, patient language, error recovery, and accessibility.
6. Expand regression coverage and align current documentation.

Do not edit historical migrations. Every database change must be a new, append-only migration after `20260801071600`. Do not raise a JavaScript budget. Do not introduce a new runtime or development dependency unless a required behavior cannot be tested with the current stack; none is expected for this spec.

## Confirmed Findings and Evidence

| ID | Severity | Finding | Current evidence |
|---|---|---|---|
| F01 | P1 | DB tests can destructively target production | `scripts/run-db-tests.mjs:4-20`; DB tests fall back through `DATABASE_URL` and delete from `patients`, `camp_days`, `camps`, `profiles`, and `auth.users`, e.g. `tests/status-queue-position.db.test.mjs:10-13,60-77`. |
| F02 | P1 | Same-day Register only silently queues an unprinted patient | `20260728113000_remove_retired_ekyc_identity.sql:321-332`; `desk-register-flow.ts:184-187,255-257`; `patient-form.tsx:1188-1216`; conflicts with `CONTEXT.md:31-40` and ADR 0008. |
| F03 | P1 | Status bearer page exposes full name | `CONTEXT.md:128`; `20260728119000_retire_doctor_counter_and_prescription_records.sql:551-593`; `src/app/s/[token]/page.tsx:20-44,161-167`. |
| F04 | P1 | Clinical lookup race can display the wrong patient | `clinical-desk.tsx:131-209,223-247,505-509`; two awaited lookups have no generation/abort ownership. |
| F05 | P1 | Status polling self-denies shared-IP patients | `src/app/s/[token]/page.tsx:14-17,56-73`; `status-auto-refresh.tsx:15-23`; `rate-limit-core.ts:70-74,101-128`; seven pages generate 14 requests/minute against a 12/minute IP bucket. |
| F06 | P2 | Readiness can be green with missing/stale clinical schema | `readiness-contract.ts:41-49,105-126`; current clinical tables/RPCs and exact overload signatures are absent; migration readiness uses name-only checks in places. |
| F07 | P2 | SMS claim leases can block delivery for decades | `20260728111000_close_sms_dispatch_ambiguity_gap.sql:58-75,126-145`; wrapper in `20260731100000_deep_review_v2_remediation.sql:35-87` forwards any integer lease to an authenticated RPC. |
| F08 | P2 | Staff Auth password policy permits weak passwords | `supabase/config.toml:184,187,230`: length 6, no composition rule, secure password change off. |
| F09 | P2 | Self-registration shares a 10-person/10-minute NAT ceiling | `src/app/api/self-registration/route.ts:25-30,71-78,154-172`; IP and person subject consume the same small limit. |
| F10 | P2 | Aadhaar scanner generation guards are incomplete | `use-aadhaar-scanner.ts:232-251,349-353,445-462`; stale USB/camera operations can write state or stop a newer session. |
| F11 | P2 | Clinical QR camera can freeze or invalidate a newer session | `patient-qr-camera.tsx:78-81,95-100,125-139`; native detector construction is not capability-guarded and rejected `jsqr` import is unobserved. |
| F12 | P2 | Staff provisioning rollback may strand an email | `src/app/api/admin/staff/[role]/route.ts:194-233`; Auth deletion failure after profile failure is ignored and retry cannot reconcile the orphan. |
| F13 | P2 | Sponsor asset Storage/DB operations are non-atomic | Upload in `api/admin/sponsor-assets/route.ts:56-70`; delete in `[id]/route.ts:53-87`; partial failure or concurrent template publication can create missing/orphaned assets. |
| F15 | P2 | Registration validation/idempotency contracts diverge | `register-scanned/route.ts:57-88`; `register-manual/route.ts:38-54`; `self-registration/route.ts:81-88`; malformed IDs/DOB/age reach privileged SQL and invalid request IDs are silently replaced. |
| F16 | P2 | `/self-register` fails the release JavaScript budget | Budget 205,000 gzip; measured eager bundle 206,222 bytes. `npm run check:js-budget` exits non-zero. |
| F17 | P2 | `/register` starts protected camp work before auth resolves | `src/app/register/page.tsx:9-13`; build logs two Cache Components prerender-completion fetch failures through `camp.ts:59-70`. |
| F18 | P2 | Staff Detail returns raw database errors | `api/admin/staff-detail/route.ts:97-102` returns Postgres messages directly. |
| F19 | P2 | Admin Staff Detail presents guaranteed-zero and mixed-attribution KPIs | `staff_person_kpis` no longer computes today/waiting; `staff-detail.tsx:127-170` still renders them and the route mixes `created_by` with `checked_in_by`. |
| F20 | P2 | Self-registration confirmation is not a form | `self-registration-flow.tsx:97-113,176-194,237-276`; required fields have no submit semantics, Enter path, field association, or first-invalid focus. |
| F21 | P2 | Patient Aadhaar recovery points to a nonexistent manual path and exposes diagnostics | `aadhaar-capture.tsx:56-75,160-180`; patient mode exposes English technical fingerprints/copy actions and says to fill identity fields that do not exist. |
| F22 | P2 | Clinical replacement dialog is not keyboard-modal | `clinical-desk.tsx:458-470,888-952`; `aria-modal` is present but background remains focusable and focus is not contained/restored. |
| F23 | P2 | Admin clinical reversal uses `window.prompt` | `admin-clinical-records.tsx:84-102`; reason capture is unlabeled, non-themeable, and has no field validation/error association. |
| F24 | P2 | Global skip link is broken on the clinical thermal slip | `layout.tsx:58-60` points at `#main`; `clinical/slip/[id]/page.tsx:43` omits that id. |
| F25 | P2 | Disclosure and Staff KPI triggers miss the 44px target floor | `aadhaar-capture.tsx:161-166`; `admin-clinical-records.tsx:150-162`; `admin-staff.tsx:393-414`; generic a11y scan omits `summary`. |
| F26 | P2 | Lookup reports outages as credential mismatch | `src/app/lookup/page.tsx:20-34`; network, invalid JSON, and server failures use the same message as a real mismatch. |
| F27 | P2 | Patient Hinglish is announced/copy-mixed as English | Root `lang=en`; `/self-register` lacks `hi-Latn` and includes English-only labels/title/actions. |
| F28 | P2 | No-JavaScript Playwright test is deterministically impossible | `e2e/roles.spec.ts:99-112` fills controls deliberately disabled by `static-login-form-shell.tsx:30-44`. |
| F29 | P2 | Playwright hydration helper flakes on polling pages | `e2e/a11y-computed.spec.ts:21-23` waits for `networkidle`; reproduced timeout on the Admin polling surface while the same test passed in an earlier run. |
| F30 | P2 | Accessibility coverage silently skips required controls/states | `a11y-computed.spec.ts` covers only admin/volunteer, omits `summary`, and guards many required controls with optional `isVisible()` branches. |
| F31 | P2 hardening | Volunteer role has tested bulk active-camp PII SELECT access | Baseline policies/grants expose address, phone, email, Aadhaar last four; `patient-read-boundary.db.test.mjs:270-277` codifies it. |
| F32 | P3 | Anonymous users can enumerate inactive/future camp-day metadata | Baseline `camp_days` anonymous SELECT policy is unrestricted while `camps` is active-only. |
| F33 | P3 | Eight workflow attribution foreign keys have no indexes | Local advisor: `deferred_slips.issued_by`, `fulfilment_events.created_by`, `fulfilment_items.resolved_by`, `prescription_corrections.created_by`, `prescription_template_versions.created_by`, `prescription_transcriptions.created_by/updated_by`, `sponsor_assets.created_by`. |
| F34 | P3 | Duplicate live regions double-announce errors | `self-registration-flow.tsx:186-194` and `section-load-error.tsx:24-25` wrap `ErrorBox`, which already has `role=alert`. |
| F35 | P3 | `text-ok` is an invalid utility | `admin-settings-panel.tsx:180`; `prescription-template-editor.tsx:259,264`; theme defines `success`, not `ok`. |
| F36 | P3 | Operational text falls to 10–11px | `team-lead-panel.tsx:129,134-135,167-168`; `sign-out.tsx:77`; poor outdoor/zoom legibility. |
| F37 | P3 | Product documentation contradicts the active clinical/self-register system | README says no clinical data and omits current role; stale comments/copy claim public self-registration is retired. |
| F38 | P3 | E2E seed hides Auth/gateway failure as `{}` | `e2e/global-setup.ts:243-277`; observed `AuthRetryableFetchError` 502 reduced to message `{}` after local DB replay. |
| F39 | P3 | E2E runner emits Node DEP0190 | `e2e/run-local.mjs` launches a fixed npm command with `shell: true`; Windows build runs warn about unsafe argument concatenation. |

## User Stories

1. As a production owner, I need DB tests to reject every non-loopback target before connecting, so a developer command cannot delete production data.
2. As a developer, I need one central test-DB URL decision, so individual files cannot silently fall back to a different database.
3. As a volunteer, I need Register only to leave a patient `registered`, so an unprinted patient never appears physically present.
4. As a volunteer, I need Print prescription to be the only `registered → waiting` transition and reprints to preserve the first print time.
5. As a patient, I need my bearer status page to omit my name and all other PII.
6. As a Clinical Desk Operator, I need the last scan/lookup to win, so I cannot edit a stale patient's record.
7. As a patient on camp Wi-Fi, I need other patients' polling not to invalidate my status link.
8. As a patient who is throttled, I need a retryable 429 response instead of a false 404.
9. As a deployer, I need readiness to prove exact tables, function signatures, grants, RLS, indexes, and storage requirements used by Clinical Desk.
10. As an SMS operator, I need claim leases bounded to 30–300 seconds, so a staff account cannot suppress a delivery for years.
11. As a staff user, I need strong password and recent-authentication rules appropriate for clinical PII.
12. As a self-registering patient behind shared NAT, I need a distinct-person attempt not to consume another person's small retry bucket.
13. As a patient scanning Aadhaar, I need stale camera/USB work ignored after I start a new scan.
14. As a Clinical Desk Operator, I need QR scanning to fall back cleanly and expose manual recovery if a decoder fails.
15. As an admin creating staff, I need a failed profile write to be recoverable with the same email.
16. As an admin publishing print assets, I need database metadata and Storage state to remain reconcilable across every partial failure.
17. As an API owner, I need every registration endpoint to reject the same malformed identity, date, UUID, and request-id inputs before privileged SQL.
18. As a patient retrying registration, I need the exact client request ID preserved; the server must not invent a replacement.
19. As a release owner, I need `/self-register` under the existing 205,000-byte gzip budget.
20. As an anonymous visitor, I need `/register` to resolve authorization before it starts protected camp reads.
21. As a staff user, I need generic safe errors instead of raw Postgres internals.
22. As an admin reviewing staff, I need Registered and Seen numbers that match original-registrar credit, with no guaranteed-zero cards.
23. As a keyboard or screen-reader user, I need self-registration confirmation to behave as a real form with field-specific errors.
24. As a patient, I need Aadhaar failure guidance that points to retry or the camp desk and hides technical diagnostics.
25. As a keyboard user, I need clinical dialogs to trap focus, close with Escape, and restore focus.
26. As a keyboard user, I need the global skip link to work on every page.
27. As a touch user, I need every summary/KPI trigger at least 44×44 CSS pixels.
28. As a patient using lookup, I need mismatch, offline, malformed-response, and server-error states distinguished in Hinglish.
29. As a screen-reader user, I need Romanized Hindi patient pages marked `hi-Latn` and patient copy consistently Hinglish.
30. As a maintainer, I need Playwright tests to wait on observable UI readiness, not impossible disabled controls or `networkidle` on polling pages.
31. As an accessibility owner, I need mandatory role/state coverage that fails when a required control disappears.
32. As a privacy owner, I need volunteers to use narrow workflow projections instead of bulk-selecting sensitive patient identity columns.
33. As an anonymous user, I need only active-camp day metadata exposed.
34. As a DBA, I need foreign-key attribution paths indexed to avoid deletion/validation scans.
35. As a screen-reader user, I need each error announced once.
36. As an operator outdoors, I need operational text at least 13px.
37. As a future maintainer, I need README, comments, role docs, and route copy to describe the current system.
38. As a developer diagnosing E2E setup, I need the original Auth status/name/code/cause preserved without secrets.

## Implementation Decisions

### Batch 0 — Make execution safe before changing behavior

1. **Centralize and fail-close DB test targeting (F01).**
   - The DB runner owns URL resolution. Default to `postgresql://postgres:postgres@127.0.0.1:54322/postgres`.
   - Accept `SNP_TEST_DATABASE_URL` only when `URL.hostname` is exactly `127.0.0.1`, `localhost`, or `::1`/`[::1]`.
   - Never read `DATABASE_URL` in DB tests. Remove that fallback from every DB test helper.
   - Validate before spawning Node's test runner. A rejected target must produce a `BLOCKER[UNSAFE-DB-TARGET]` message containing host/database only, never credentials.
   - Pass the single validated value to child tests as `SNP_TEST_DATABASE_URL`.

2. **Repair the E2E harness (F28, F29, F38, F39).**
   - The no-JS login test must assert static fields/buttons are disabled and that neither URL query nor fragment contains credentials. It must not fill or click disabled controls.
   - Replace shared `networkidle` waiting with `page.goto(..., { waitUntil: "domcontentloaded" })`; each test must then wait for its first required named control/heading. Do not add sleeps.
   - Serialize Auth setup failures using safe structured fields: error name, HTTP status, code, and message. Never serialize headers, keys, or request bodies.
   - Add a preflight `listUsers`/temporary-user capability check before fixtures. On gateway/Auth failure, stop with an actionable local-stack error instead of continuing to fixture creation.
   - On Windows, launch `npm.cmd` directly without `shell: true`; keep all arguments in the spawn array.

3. Batch 0 is complete only when its runner unit tests pass and a deliberately remote URL is rejected without a network connection.

### Batch 1 — Restore the four critical runtime contracts

4. **Printing alone queues patients (F02).**
   - Append a migration replacing `register_patient_idempotent` with the same public signature and grants, but every new registration begins as `registered`, `queued_at = NULL`, `checked_in_by = NULL`, whether it is today, future, desk, or self-service.
   - Keep capacity behavior from the current accepted implementation: same-day desk walk-ins may register when the day is full; self-service/future pre-registration remains capacity-limited.
   - `mark_patient_printed` remains the only queue transition. Preserve idempotency: first print sets `queued_at` and actor; reprint preserves both; a `seen` patient may reprint paper without re-entering the queue.
   - Update desk-flow comments and expectations that currently claim registration already queued the patient. Do not add a fourth state or a check-in UI.

5. **Strip status-page PII (F03).**
   - Append a migration replacing the exact `patient_status_by_token(text)` return shape without `full_name` or any phone, email, address, Aadhaar, date-of-birth, or audit field.
   - Retain registration number, queue status/position, camp/day/venue, and the intended staff-scan QR identifier.
   - Remove full-name mapping and the Name block from the page. Do not amend the privacy contract to permit the leak.

6. **Make latest Clinical Desk lookup authoritative (F04).**
   - Add one monotonically increasing lookup generation shared by exact and follow-up lookups.
   - Increment on every lookup start, explicit clear/patient change, and unmount.
   - Capture the generation and intended patient identity; after every await, return without any state write unless both are still current.
   - Mutation refreshes may update the form only when the captured patient ID still matches the displayed patient. Disable/stop scanner input while a mutation owns the record.

7. **Separate IP and token status limits (F05).**
   - Validate token format before any rate-limit consumption.
   - Extend the rate-limit adapter minimally so IP and subject hashes can be consumed in separate calls/scopes; do not give both the same limit.
   - Use a per-token distributed limit of **12 requests/minute** and a per-IP distributed/in-memory abuse ceiling of **1,200 requests/minute** for valid-format tokens.
   - Return **429** with `Retry-After` when either limit is exceeded. Keep 404 only for invalid format or a valid-format token with no record.
   - Keep the 30-second visibility-aware refresh cadence.

### Batch 2 — Database, Auth, readiness, and privacy hardening

8. **Make readiness exact (F06).**
    - Add these exact tables to `REQUIRED_TABLES`: `prescription_transcriptions`, `prescription_corrections`, `fulfilment_items`, `fulfilment_events`, `deferred_slips`, `prescription_template_versions`, `sponsor_assets`, and `aadhaar_extraction_events`.
    - Add every column declared for those tables in migrations `20260730040210` and `20260730065231`, plus the new sponsor lifecycle columns from F13, to `REQUIRED_COLUMNS`. Add invariant facts for: transcription patient uniqueness; fulfilment `(transcription_id,kind)` uniqueness; one active deferred slip; one published and one draft template per camp; sponsor object-key uniqueness/state check; Aadhaar event patient uniqueness; RLS enabled on all eight tables; and private `prescription-sponsors` bucket with 2,097,152-byte PNG/JPEG/WebP restrictions.
    - Replace name-only function checks with these exact `regprocedure` signatures: `is_clinical_operator()`, `assert_valid_clinical_data(jsonb)`, `clinical_lookup(uuid,integer)`, `clinical_save_transcription(uuid,jsonb)`, `clinical_add_correction(uuid,jsonb,text)`, `clinical_resolve_item(uuid,text,text)`, `clinical_followup_fulfil(uuid)`, `clinical_followup_lookup(uuid,integer)`, `clinical_slip_by_id(uuid)`, `clinical_replace_slip(uuid,date,text,text)`, `admin_prescription_template_editor(uuid)`, `admin_save_prescription_template(uuid,jsonb,boolean)`, `admin_clinical_records(uuid,boolean,integer,integer)`, `admin_archive_transcription(uuid,boolean)`, `admin_reverse_fulfilment(uuid,text)`, `published_prescription_template(uuid)`, and `audit_scanned_aadhaar_registration()`.
    - Grant facts: none of those functions is executable by `PUBLIC` or `anon`; the 15 callable clinical/template functions (including `is_clinical_operator()`) are executable by `authenticated`, `service_role`, and `postgres`; `assert_valid_clinical_data(jsonb)` and the audit trigger function remain service-role/postgres only. All eight tables deny browser writes; `aadhaar_extraction_events` denies every browser operation.
    - Convert every existing non-clinical readiness entry to these exact signatures: `active_registration_id(uuid,integer)`, `camp_queue_counts(uuid)`, `check_in_patient(uuid,integer)`, `claim_sms_delivery(uuid,sms_delivery_kind,text,integer)`, `complete_sms_delivery(uuid,uuid,text,text,text)`, `consume_public_rate_limit(text,text[],integer,integer)`, `latest_applied_migration()`, `lookup_patient_scan(uuid,integer)`, `lookup_patient_status_token(integer,date)`, `mark_seen(uuid,integer)`, `mark_sms_dispatch_started(uuid,uuid)`, `patient_registration_notify_fields(uuid)`, `patient_status_by_token(text)`, `readiness_catalog_probe()`, `register_patient_idempotent(uuid,uuid,text,text,integer,text,text,text,text,uuid,uuid,uuid,boolean,boolean,boolean,text,text,date,text)`, `search_desk_patients(uuid,text,integer)`, `undo_mark_seen(uuid)`, and `upsert_camp_day(uuid,date,integer,uuid)`.
    - Replace the old KPI signature with `staff_person_kpis(uuid,text,uuid,text)`, and add `desk_waiting_queue(uuid,integer)`, `print_patient(uuid)`, `staff_registered_patients(uuid,integer)`, `begin_sponsor_asset_deletion(uuid)`, and `finish_sponsor_asset_deletion(uuid)`. Their grant facts must match their implementation decisions below; no same-name extra overload may remain.
   - Update the expected migration head with the new migration in this spec.
   - Add negative tests that remove one required object, substitute a same-name wrong overload, and revoke one grant inside rolled-back disposable transactions; all must turn readiness red.

9. **Bound SMS leases (F07).**
   - Preserve the current RPC signature for compatibility.
   - In the privileged implementation, require `p_lease_seconds BETWEEN 30 AND 300`; otherwise raise SQLSTATE `22023`.
   - Keep the current default within that range and preserve reclaim-after-expiry behavior.

10. **Harden staff passwords (F08).**
    - Set local policy to minimum **12** characters, `lower_upper_letters_digits_symbols`, and secure password change enabled.
    - Rename the stale `patient-password` helper to `staff-password` and make it the single contract used by staff creation, reset, and change-password UI. Delete the route-local duplicate generator.
    - The temporary-password generator defaults to **16** characters and must guarantee at least one lowercase letter, uppercase letter, digit, and symbol. Use unambiguous lower/upper/digit alphabets plus the fixed symbol set `!@#$%&*+-=?`, fill remaining positions from the combined set with `randomInt`, and cryptographically shuffle the result so required classes are not in predictable positions.
    - Client/server password validation and copy must require the same four classes and minimum length, not length alone. Keep maximum handling delegated to Supabase Auth.
    - Add an operations checklist requiring the linked hosted Supabase Auth project to match these values and enable leaked-password protection when the plan supports it. Do not put dashboard secrets in the repository.

11. **Narrow volunteer patient access (F31).**
    - Replace the broad active-staff patient SELECT RLS policy with an admin-only direct SELECT policy. Keep the authenticated table grant because admin screens use it; RLS must deny team lead, volunteer, and clinical-operator direct table SELECT.
    - Add `desk_waiting_queue(uuid,integer)` as an authenticated SECURITY DEFINER RPC. It accepts only the active camp, caps the requested limit at **101** (the current 100-row display plus sentinel), and returns only `id`, `reg_no`, `full_name`, `phone`, `queued_at`, plus the exact waiting total. Use it in `loadQueueSection` and `/api/desk/live`; remove both direct patient queries/counts.
    - Add `print_patient(uuid)` as an authenticated SECURITY DEFINER RPC for active registration staff. It returns one active-camp patient only with the existing print projection: `id`, `reg_no`, `full_name`, `age`, `gender`, `address`, `phone`, `queue_status`, camp `id/name/venue/prescription_template`, and camp-day `day_date`. Use it in `loadPrintSlips`; it never accepts an array or search predicate.
    - Add `staff_registered_patients(uuid,integer)` as an authenticated SECURITY DEFINER RPC with the same authorization predicate as the person-scope KPI. Cap at 50 and return only `id`, `reg_no`, `full_name`, `created_at`, and `queue_status` where `created_by` equals the requested staff ID. Use it in Staff Detail.
    - Keep existing `search_desk_patients` and `lookup_patient_scan` for search/scan; do not add fields to them. Admin patient screens retain direct RLS-authorized access. Self-registration, reminder, and other service-role code remains unchanged.
    - All three new RPCs deny `PUBLIC`/`anon`, use a fixed `pg_catalog,public` search path, appear in readiness by exact signature, and receive runtime DB role-boundary tests.

12. **Restrict anonymous camp days (F32).**
    - Revoke anonymous `camp_days` SELECT and remove its anonymous policy entirely.
    - `active_camp_snapshot()` is the sole anonymous camp/day contract; self-registration must continue to load the active camp and its days through that RPC only.

13. **Index confirmed foreign keys (F33).**
    - Add ordinary btree indexes for all eight attribution foreign keys listed in F33, using deterministic `idx_<table>_<column>` names.
    - Do not remove unrelated indexes based on the fresh-database unused-index advisor.

### Batch 3 — Registration, scanners, provisioning, and assets

14. **Split self-registration quotas (F09).**
    - Before body processing, enforce the per-instance IP scope at **300 attempts/10 minutes**.
    - After parsing and creating the service client, consume a distributed IP-only scope at **300 attempts/10 minutes** and, after deriving the person duplicate key, a separate distributed subject-only scope at **5 attempts/10 minutes**.
    - Return 429 with `Retry-After`; fail closed with 503 if the durable subject gate is unavailable.

15. **Complete scanner generation ownership (F10, F11).**
    - Every async camera, constraints, playback, decoder import, decode, and `onParsed` operation captures a generation and rechecks it after every await.
    - A stale branch may clean up only resources it created; it may not call the global stop, write error/busy/result state, attach video, or invoke patient callbacks.
    - Clinical QR uses the existing native QR-capability helper. Catch constructor/detect/import/loop failures, stop owned tracks, show a safe error, and preserve manual lookup recovery.

16. **Make staff creation reconcilable (F12).**
    - If profile creation fails, inspect Auth rollback.
    - If rollback fails, return an explicit reconciliation-required safe code and log the Auth user ID server-side.
    - A retry by an authorized manager with the same normalized email must detect an Auth user with no usable profile, update its password/metadata, and finish the profile transaction; it must never take over an account with an existing active profile.

17. **Add sponsor-asset lifecycle state (F13).**
    - Append a migration adding a non-null `state` check-constrained to `pending`, `ready`, or `deleting`, defaulting existing/new rows to `ready`; also add `state_changed_at timestamptz NOT NULL DEFAULT now()`, `cleanup_attempts integer NOT NULL DEFAULT 0`, and nullable `last_error_code text` (safe code only, never provider text).
    - Upload through the existing POST route: insert pending metadata first, upload the object, then mark ready. If upload fails, delete the pending row; if that cleanup fails, leave it pending with `last_error_code='UPLOAD_OR_CLEANUP_FAILED'`. Never expose a non-ready asset in template selection.
    - Add admin-only `begin_sponsor_asset_deletion(uuid)` and `finish_sponsor_asset_deletion(uuid)` SECURITY DEFINER RPCs. Begin locks the row, rejects any draft/published template reference, changes ready/pending to deleting, clears the last error, and returns the object key. If the row is already deleting, begin succeeds idempotently and returns the existing object key without changing state; this is the retry path. Finish deletes metadata only when state is deleting.
    - The existing DELETE route calls begin, removes the Storage object, treats object-not-found as success, then calls finish. Other Storage failure increments `cleanup_attempts`, records only `STORAGE_DELETE_FAILED`, leaves deleting, and returns 502. Repeating DELETE on pending/deleting is the sole reconciliation action.
    - Admin asset GET/UI lists all three states. Pending shows **Clean up upload** and deleting shows **Retry deletion**; both invoke the existing DELETE route. No cron, CLI, new endpoint, or automatic sweep is added.
    - Template save/publish resolves every `/api/admin/sponsor-assets/<uuid>` reference to a same-camp ready row and locks all referenced rows `FOR SHARE` until the template transaction commits. Begin deletion uses `FOR UPDATE` before its reference check. This lock ordering makes concurrent publish/delete serialize: publication either commits first and deletion is rejected, or deletion marks the asset and publication is rejected.

18. **Unify server registration validation (F15).**
    - Create one small server-only `registration-input` validation module that reuses the existing household-phone validator. It owns UUID/request-ID validation; a real, non-future ISO calendar DOB; age 0–149; staff gender as null or M/F/O; self-service gender as required M/F/O; full/display names up to 80 code points; address up to 120 code points; and email up to 254 code points with the existing email shape rule.
    - Scanned, manual, and self-service routes must reject malformed input before creating a service-role client or calling an RPC.
    - Missing/invalid `requestId` is a 400 validation error. Never generate one at the endpoint. The browser remains responsible for generating and reusing a UUID across retries.

### Batch 4 — Release, KPI, UI, language, and accessibility repairs

19. **Restore the JS budget without moving the goalpost (F16).**
    - Add a minimal client dynamic boundary around `SelfRegistrationFlow`, following the existing lazy scanner pattern.
    - Keep the page server component and a stable accessible loading shell.
    - Do not raise 205,000 bytes and do not move QR decoders into the eager route.

20. **Authorize before protected camp fetch (F17).**
    - Resolve the session/profile first. Redirect or render the unauthorized state before starting the fresh camp query.
    - Fetch the camp only for authorized registration staff. The production build must emit no `[camp] active camp snapshot failed` prerender-completion message.

21. **Make Staff Detail truthful and safe (F18, F19).**
    - Remove the obsolete `p_since` argument from `staff_person_kpis` with an append-only migration that drops the old exact signature and recreates the unambiguous replacement; update all callers.
    - Staff Detail renders exactly Registered and Seen, using original-registrar credit. Remove Handled today and In queue.
    - The patient list is registration attribution (`created_by = selected staff`) rather than a union with `checked_in_by`; title it accordingly.
    - Map DB failures through the safe public-error layer and log raw details only server-side.

22. **Repair patient forms/copy/error recovery (F20, F21, F26, F27).**
    - Render self-registration confirmation as `<form>` with `onSubmit`, a submit button, field error elements, `aria-invalid`, `aria-describedby`, and first-invalid focus. Enter submits exactly once while busy guards remain active.
    - Mark patient-facing self-registration content `lang="hi-Latn"`. Convert English-only title, labels, action, and receipt labels to concise Hinglish while keeping IDs/technical values unchanged.
    - Patient Aadhaar mode says retry or visit the camp desk; it hides fingerprint/format/copy diagnostics. Staff mode retains diagnostics in English.
    - Lookup distinguishes credential mismatch (4xx contract), throttling, network failure, malformed JSON, and 5xx. Non-mismatch failures receive retryable Hinglish copy.

23. **Use real modal behavior (F22, F23).**
    - Follow the repository's existing native `<dialog>.showModal()` pattern for Clinical replacement and Admin reversal reason forms.
    - Provide labels, field validation, focus containment, Escape, background inertness, and focus restoration. No `window.prompt` or new dialog dependency.

24. **Repair navigation/touch/live-region styling (F24, F25, F34, F35, F36).**
    - Add `id="main"` to the clinical slip main element.
    - Replace both raw diagnostic/record `<details>` blocks with the existing compliant `CollapsibleSection` pattern. Add `min-h-12`, vertical alignment, padding, and the existing focus-ring classes directly to the Staff KPI button.
    - Add `summary` to the generic touch-target scan.
    - Remove outer alert/live roles around `ErrorBox`; exactly one alert remains per error.
    - Replace `text-ok` with `text-success`.
    - Raise identified 10–11px operational text to at least 13px while preserving hierarchy.

### Batch 5 — Coverage and documentation

25. **Make the a11y matrix mandatory (F30).**
    - Cover admin, team lead, volunteer, clinical operator, self-registration after scan, status page, Admin clinical records, malformed Aadhaar diagnostics, and both A4 and two-inch print surfaces.
    - Remove optional visibility guards for controls required by the scenario; absence is a failure.
    - Check actual accessible names and keyboard traversal, not text-content approximations.
    - Add a two-inch slip PDF/page-size assertion using existing Playwright/PDF tooling. Do not add Axe merely for ceremony.

26. **Align docs and stale copy (F37).**
    - README must describe Clinical Desk Operator, transcription/fulfilment data, current self-registration, current role table, and privacy boundary.
    - Remove comments and anonymous `/register` copy that claim public self-registration is retired/unavailable; link patients to `/self-register` where appropriate.
    - Add the exact status/self-registration rate thresholds and 12-character staff-password baseline to `CONTEXT.md` under the existing production-safety boundary. Do not change any ADR or other domain rule.

## Testing Decisions

Use the highest existing seam that proves each behavior. Prefer empirical runtime/RPC/HTTP/Playwright assertions over source-regex tests.

### Required regression map

| Finding(s) | Required seam |
|---|---|
| F01 | Runner unit test that spies on spawn/connect; remote URL must fail before either. |
| F02 | DB test plus register-only and register-and-print Playwright cases; assert state/timestamps. |
| F03 | DB return-shape test plus rendered-route test proving seeded name absent. |
| F04 | Deferred-promise component test A→B, resolve B then A; B remains authoritative. |
| F05, F09 | Rate-limit unit/RPC/route tests using distinct IP/subject populations and exact `Retry-After`. |
| F06 | Rolled-back destructive readiness-negative tests for missing object, wrong overload, revoked grant. |
| F07 | Authenticated DB test for 29, 30, 300, and 301-second leases. |
| F08 | Config contract plus staff-password unit/route tests: reject old six-character/simple values; creation/reset generators produce 200 samples that are at least 16 characters and each contain lower, upper, digit, and allowed symbol; change-password UI rejects every missing-class case before Auth; hosted setting verified manually and recorded. |
| F10, F11 | Deferred getUserMedia/decoder/native-detector tests with owned-track cleanup assertions. |
| F12 | Route fault injection: profile fail + rollback fail + authorized retry reconciliation. |
| F13 | Storage/DB fault injection at every step and concurrent publish/delete integration test. |
| F15 | Route tests assert malformed payloads never call RPC and stable IDs are forwarded unchanged. |
| F16 | `npm run build && npm run check:js-budget`; decoder markers remain deferred. |
| F17 | Production build stderr contains no camp/prerender error; authenticated route still loads data. |
| F18, F19 | Route/RPC tests plus Admin Staff Detail UI assertion for only Registered/Seen and safe errors. |
| F20–F27, F34–F36 | Playwright/component accessibility tests: Enter submit, field focus/association, dialogs, skip link, target bounds, one alert, language, distinct error copy, computed class/style. |
| F28, F29, F38, F39 | Full Playwright suite completes without timeout, `{}` setup error, `networkidle`, or DEP0190. |
| F30 | Mandatory route/state matrix; delete/hide a required test fixture control locally to prove the test fails, then restore. |
| F31, F32 | DB role-boundary tests for volunteer direct SELECT and anonymous inactive-day denial. |
| F33 | Local advisor must report no `unindexed_foreign_keys` for the eight listed constraints. |
| F37 | Documentation/route contract assertions only where behavior is machine-verifiable; otherwise reviewer checklist. |

### Batch gates

After every batch:

1. Run the focused new/changed tests.
2. Run `npm run lint` and `npx tsc --noEmit` for TypeScript/UI batches.
3. Run `npm test` for every batch.
4. For migration batches, run `npm run test:db:replay`, require zero DB skips, run `npx supabase db lint --local --schema public --level warning`, and run `npx supabase db advisors --local --type all --level warn`.
5. Review `git diff --check`, the scoped diff, grants, rollback behavior, and raw-error exposure before starting the next batch.

Final integrated gate:

```text
npm run lint
npx tsc --noEmit
npm test
npm run test:db:replay
npm run compare:migrations -- --require-local --skip-linked
npm run build
npm run check:js-budget
npm run test:e2e
npm run check:env
npm audit --omit=dev
```

Then run `npm run verify` once against the validated loopback database. All commands must exit zero; DB skips are failures. Build stderr must not contain the known camp-prerender error, and E2E stderr must not contain DEP0190.

## Executor Work Order for Luna

1. Work on one batch only. Write failing regression tests first for that batch.
2. For database behavior, create one or more new timestamped migrations after the current head. Never edit, squash, reorder, or delete existing migrations.
3. Preserve exact SECURITY DEFINER owner, fixed search path, grants, revokes, comments, and RPC signatures unless this spec explicitly changes the signature.
4. Do not continue when a batch gate is red. Diagnose and fix it before touching the next batch.
5. Do not raise budgets, relax privacy assertions, skip tests, add arbitrary sleeps, or make optional assertions to obtain green.
6. Do not refactor unrelated code. Reuse current validators, public-error mapping, QR session/capability helper, dialog pattern, lazy boundary pattern, and test harness.
7. Commit or checkpoint each green batch separately so it can be reverted independently.
8. After Batch 5, request an independent review specifically for queue transitions, Auth/DB test safety, SECURITY DEFINER grants, status response shape, scanner generation ownership, and sponsor lifecycle failure recovery.

## Acceptance Criteria

1. A non-loopback test database is rejected before any process connects or mutates.
2. Every newly registered patient begins `registered`; only a print action establishes `waiting` and the immutable queue time.
3. Status HTML/RSC/RPC contains no patient full name or other PII.
4. Stale Clinical Desk or scanner work cannot alter the newest patient/session.
5. At least seven status pages on one IP remain available at the production polling cadence; throttling is 429, never false 404.
6. Readiness fails for a missing required clinical object, a wrong same-name overload, or a revoked grant.
7. SMS leases, Auth password policy, volunteer/anonymous reads, and the eight FK indexes meet the decisions above.
8. Registration retries preserve their client UUID and malformed registration input never reaches privileged SQL.
9. Sponsor asset workflows recover safely from every injected partial failure.
10. `/self-register` is at or below 205,000 eager gzip bytes; no budget is increased.
11. Admin Staff Detail shows only truthful Registered/Seen attribution and no raw DB error.
12. Patient-facing flows are consistently Hinglish/`hi-Latn`, distinguish recoverable errors, and expose no staff diagnostics.
13. All modal, skip-link, target-size, live-region, form, language, and print accessibility assertions pass.
14. Full DB replay, unit, build, budget, Playwright, environment, advisor, migration-head, and dependency checks pass with zero hidden skips.

## Out of Scope

- Changing the three queue states or adding a separate check-in action.
- Replacing paper as the clinical record or reintroducing the retired Doctor Station.
- Replacing bearer status links with accounts/sessions.
- Full UIDAI Secure QR cryptographic verification or OTP/eKYC.
- Realtime patient channels; polling remains the accepted boundary.
- An i18n framework or wholesale copy rewrite outside the affected patient surfaces.
- A UI redesign, framework migration, database rewrite, or speculative abstraction pass.
- Raising JavaScript budgets, weakening tests, or suppressing build/runtime errors.
- Deploying to production, applying migrations to a linked remote database, changing hosted Auth settings, or deleting production data. Those require a separate authorized rollout.

## Further Notes

### Audit evidence

- Graphify code-only deep graph: 1,716 nodes, 3,224 edges, 185 communities; no dependency cycles. Documentation semantic mapping was unavailable because no Graphify API key was configured, so critical conclusions were verified directly against source and tests.
- Lint: pass.
- TypeScript: pass.
- Unit suite: 401 tests, 391 pass, 0 fail, 10 intentionally skipped by that runner; database tests ran separately.
- Clean migration replay: 76 migrations through `20260801071600`.
- Database suite: 134 pass, 0 fail, 0 skipped.
- Local database lint: one warning, obsolete `staff_person_kpis.p_since`, addressed by F19.
- Local security/performance advisor: no warn/error security findings; eight confirmed unindexed foreign keys.
- Production build: exits zero but emits two confirmed `/register` prerender-completion errors.
- JavaScript budget: only `/self-register` fails, 206,222 > 205,000 gzip.
- Dependency audit: zero production vulnerabilities.
- Playwright: after excluding the deterministic no-JS test, 28 pass and one polling-page `networkidle` timeout; full unfiltered run stalls on the no-JS test.
- Migration comparison: repository, contract, and local applied heads all match `20260801071600`.

### Clean areas / rejected hypotheses

- No credible role-auth bypass, service-role key exposure, CSP script bypass, public Supabase patient-table access, PUBLIC-executable SECURITY DEFINER function, unsafe definer search path, public view leak, or patient Realtime publication was found.
- Status-token entropy, cron secret comparison, capacity locks, duplicate advisory locks, and SMS completion-token concurrency are sound aside from the explicit findings above.
- QR image-size hardening and some complex-function refactors were not included without a reproducible failure.
- Fresh-database `unused_index` notices are not a deletion instruction.
- Graphify complexity/god-node scores alone are not bugs and are not implementation scope.
- A proposed multi-patient print atomicity finding was withdrawn during independent review: the only current `PrintActions` caller passes a one-element array, so no reachable batch sheet exists. Finding IDs remain stable to preserve the audit evidence ledger.

### Skill manifest

| Skill | Purpose | Output used |
|---|---|---|
| LeanCTX | Focused retrieval and compressed verification logs | Source evidence, test/build/DB outputs |
| Graphify | Repository structure and impact mapping | Cross-layer hotspots and graph baseline |
| find-skills | Narrow capability discovery | Confirmed installed Supabase/Next/React/testing skills were sufficient; no duplicate skill installed |
| to-spec | Decision-complete executor specification | This document and GitHub issue |
| Ponytail | Minimal-diff discipline | Append-only/local fixes, no new dependencies or speculative refactors |
| Supabase/Postgres best practices | RLS, grants, indexes, locks, privileged RPC review | DB/security findings and migration constraints |
| Next.js/React best practices | App Router, async/lifecycle, bundle review | Auth-fetch ordering, race and bundle decisions |
| webapp-testing/check-work | Browser and independent verification | Playwright evidence and final review gate |
