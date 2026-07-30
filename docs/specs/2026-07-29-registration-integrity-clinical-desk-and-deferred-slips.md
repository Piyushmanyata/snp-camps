# Aadhaar-only registration, outcome leaderboards, Clinical Desk, and deferred slips

## Problem Statement

The camp registration desk currently permits optional phone numbers and exposes a manual identity path too broadly. It also credits staff activity in ways that can be inflated without a patient completing the doctor journey. These behaviors make household communication unreliable, weaken Aadhaar-scan provenance, and create a leaderboard that rewards actions rather than patient outcomes.

After a doctor visit, the application has no intentionally bounded way to capture the operational fields from the handwritten prescription, record whether medicine or fixed-power spectacles were supplied, record whether Specs or OT was deferred, print follow-up instructions, or later complete unresolved care. Restoring the previous doctor/counter/treatment-order system would reintroduce roles and complexity that the live camp does not use.

Admins also cannot safely change sponsor logos and approved layout sections on the A4 prescription without a code release.

The product needs a scan-first registration boundary, an outcome-qualified leaderboard, a new least-privilege Clinical Desk Operator, two private 58 mm deferred-care slips, retained and auditable fulfilment history, and a constrained A4 template editor. The existing `registered → waiting → seen` queue and the doctor's paper prescription as the prescribing source of truth must remain intact.

## Solution

Require a valid household contact phone before opening the Aadhaar scanner at the registration desk. Volunteers register only from Aadhaar QR data. After three failed scan attempts, a Team Lead or admin may use an audited manual exception from their own account; the exception is never available to volunteers or Clinical Desk Operators and never earns leaderboard credit.

Replace activity-based competitive metrics with original-registrar attribution. Before the first Camp Day, rank volunteers and teams by eligible registrations to motivate pre-registration. From the first Camp Day onward, rank by eligible registrations that reached `seen`, while retaining Registered as a secondary column. A Registration can contribute at most once and walk-ins count when seen.

Add a station-only `clinical_operator` role. After exact Patient QR or registration-number lookup, the operator may transcribe the doctor's paper prescription only when the Registration is `seen`. Medicine, Specs, and OT are independent fulfilment items. Fixed-power spectacles or medicine handed over at camp are fulfilled; unavailable medicine is retained for follow-up; deferred Specs and OT each create a separate, versioned 58 mm slip using the relevant admin-configured date and venue.

Lock the original transcription on the first fulfilment decision. Preserve later changes as reasoned, append-only corrections and fulfilment events. Provide a narrow exact-lookup follow-up mode for unresolved historical items without allowing broad clinical search or historical prescription editing.

Give admins a structured, versioned A4 prescription-template editor for approved blocks and safe sponsor assets. Fixed patient identity, registration number, and Patient QR content cannot be removed or rearranged outside their protected area, and a template cannot be published if it exceeds one A4 page.

## User Stories

1. As a Volunteer, I must enter a valid 10-digit Indian household contact phone before the Aadhaar scanner opens, so every desk registration has a usable contact.
2. As a Volunteer, I can use the same household phone for several family members, so a family with one phone can register each distinct Person.
3. As a Volunteer, I am told that the phone is a contact field rather than an identity field, so shared numbers do not appear suspicious.
4. As a Volunteer, I cannot submit a blank, malformed, or obvious repeated-digit dummy phone, so mandatory contact data is meaningful.
5. As a Volunteer, I do not receive a phone-only duplicate warning, so shared household phones do not interrupt registration.
6. As a Volunteer, I can register a patient only from a successfully parsed Aadhaar QR, so I cannot type or alter identity details manually.
7. As a Volunteer using the registration laptop, I can scan Aadhaar with a keyboard-wedge USB QR scanner after phone validation, so the complete payload can be captured accurately.
8. As a Volunteer, each failed Aadhaar scan advances a visible attempt count without retaining the failed payload, so I know when to ask for help.
9. As a Volunteer, after three failed scans I see “Ask Team Lead” and no manual identity form, so the exception stays outside my account.
10. As a Team Lead or admin, I can manually enter identity details only after the failed-scan threshold, from my own authenticated account, and after choosing a reason.
11. As an auditor, I can identify the actor, timestamp, selected reason, recorded attempt count, and manual provenance of every exception.
12. As a Team Lead, I cannot lend a manual-entry screen to a Volunteer without the action remaining attributable to my account.
13. As a Clinical Desk Operator, I cannot register a patient or use the manual Aadhaar exception.
14. As a registrar, scanning an Aadhaar-derived Person who already exists returns that Person rather than creating a duplicate.
15. As a registrar, a possible same-name-and-age patient produces the existing secondary warning, while a same-phone patient does not.
16. As a Volunteer, I receive pre-camp Registered credit only for eligible, non-manual Registrations originally created by me.
17. As a Volunteer, from the first Camp Day onward I receive exactly one Seen point when a Registration originally created by me reaches `seen`.
18. As a Volunteer, a walk-in I registered counts after the patient reaches `seen`.
19. As a Volunteer, printing, reprinting, marking seen, scanning repeatedly, transcribing, fulfilling, deferring, or reprinting slips gives no additional point.
20. As a Volunteer, another staff member's later actions cannot take or reassign my original-registrar credit.
21. As a Team Lead, I see my team's eligible aggregate and headcount under the same pre-camp/live-camp rule.
22. As Registration Staff, I see separate Registered and Seen-from-your-registrations values, so pre-registration motivation is not confused with completed attendance.
23. As an admin, I can create, disable, and manage a Clinical Desk Operator account without granting Registration Staff permissions.
24. As a Clinical Desk Operator, my role home is the Clinical Desk and does not expose registration, A4 prescription printing, mark-seen, staff administration, or leaderboards.
25. As a Clinical Desk Operator, I can open a patient by scanning the Patient QR with the camera or by typing the exact registration number.
26. As a Clinical Desk Operator, I cannot browse or search the patient population by name, phone, diagnosis, or other clinical field.
27. As a Clinical Desk Operator, I receive a clear refusal when the selected Registration has not reached `seen`, and no clinical details are exposed.
28. As a Clinical Desk Operator, I can enter diagnosis option(s) plus Other, optional blood sugar, optional blood pressure, remarks/advice, and medicines from the handwritten paper.
29. As a Clinical Desk Operator, when Specs is required I can enter the approved spectacles type and right/left eye distance sphere, cylinder, axis, vision, near addition or sphere, and PD fields.
30. As a Clinical Desk Operator, when OT is required I can enter right, left, or both eyes, diagnosis/procedure, and notes.
31. As a Clinical Desk Operator, the system requires fields relevant to a selected Specs or OT item but does not force irrelevant clinical fields.
32. As an auditor, every transcription records its operator and timestamps automatically while continuing to identify the paper as the prescribing source.
33. As a Clinical Desk Operator, I can save and revise a transcription freely until the first Medicine, Specs, or OT outcome is resolved.
34. As a Clinical Desk Operator, the first fulfilment or defer decision locks the original transcription against silent overwrite.
35. As a Clinical Desk Operator or admin, I can append a correction after lock only by entering a reason; the original, author, and timestamps remain available.
36. As Registration Staff, I cannot read or mutate clinical transcription, fulfilment, correction, or slip data.
37. As a Clinical Desk Operator, I can mark Medicine as fulfilled, not available, or not required.
38. As a Clinical Desk Operator, I can mark Specs independently as fulfilled, deferred, or not required.
39. As a Clinical Desk Operator, I can mark OT independently as fulfilled, deferred, or not required.
40. As a Clinical Desk Operator, I mark medicine handed over at camp as fulfilled and unavailable medicine as not available.
41. As a Clinical Desk Operator, I mark fixed-power spectacles handed over at camp as fulfilled rather than deferred.
42. As a Clinical Desk Operator, I may resolve different items differently for the same patient, including fulfilling Medicine while deferring Specs and OT.
43. As a Clinical Desk Operator, deferring Specs is refused when the configured Specs collection date or venue is missing, without discarding the transcription or blocking unrelated outcomes.
44. As a Clinical Desk Operator, deferring OT is refused when the configured OT date or venue is missing, without discarding the transcription or blocking unrelated outcomes.
45. As a Clinical Desk Operator, a successful Specs defer creates one active Specs slip version and immediately offers printing.
46. As a Clinical Desk Operator, a successful OT defer creates one active OT slip version and immediately offers printing.
47. As a patient deferred for both services, I receive two separate slips rather than a combined slip.
48. As a patient, each 58 mm slip shows camp name, a large Specs or OT heading, my name, registration number, age/gender, the matching date and venue, Patient QR, issue timestamp, and slip reference/version.
49. As a patient, the small slip does not expose my address, Aadhaar data, full phone, measurements, or full prescription.
50. As a Clinical Desk Operator or admin, I can reprint the active slip without creating a new deferral, timestamp, version, or leaderboard event.
51. As a Clinical Desk Operator or admin, correcting slip instructions cancels the old active version and creates a replacement; the cancelled version remains audit-only.
52. As a Clinical Desk Operator, I cannot print a cancelled or already-fulfilled slip as though it were active.
53. As an auditor, a slip preserves the date and venue that were issued even if the camp settings later change.
54. As a Clinical Desk Operator, after opening a current Registration I can view read-only prior clinical history for the same Person, but I can edit only the current camp record.
55. As a Clinical Desk Operator in follow-up mode, exact QR or registration-number lookup shows that Person's unresolved deferred Specs/OT and not-available Medicine items from prior camps.
56. As a Clinical Desk Operator in follow-up mode, I can mark an unresolved item fulfilled without editing the historical prescription.
57. As an auditor, later fulfilment records the operator and timestamp while preserving the original deferral, unavailable event, and slip history.
58. As an admin, I can reverse an incorrect later fulfilment only through a reasoned correction.
59. As an admin, I can review and export authorized clinical and fulfilment records, while Clinical Desk Operators cannot bulk export them.
60. As an admin, I can archive historical clinical records out of routine views without hard-deleting the audit trail.
61. As a patient using the public status page, I never see diagnosis, medicine, measurements, procedure, fulfilment, or other clinical PHI.
62. As a Clinical Desk Operator during an outage, I use the paper prescription as the recovery source and do not store clinical PHI offline.
63. As a Clinical Desk Operator, I cannot create a deferred record or print a slip until the server has successfully saved the decision.
64. As Registration Staff, I can undo mark-seen within the existing ten-minute window only before a Prescription Transcription exists.
65. As Registration Staff, once clinical transcription starts I cannot return the patient to `waiting`; a later correction belongs to the admin workflow.
66. As an admin, I can create a draft A4 prescription-template version without changing the currently published form.
67. As an admin, I can upload multiple PNG, JPEG, or WebP sponsor logos up to 2 MB each and reorder or remove them.
68. As an admin, unsafe SVG files, oversized files, and arbitrary external image URLs are rejected.
69. As an admin, I can reorder approved form blocks, change allowed labels and visibility, and select bounded writing-area heights.
70. As an admin, I cannot remove or freely reposition protected patient identity, registration-number, and Patient QR content.
71. As an admin, I see a live A4 preview and cannot publish a template that renders beyond one page.
72. As an admin, I can publish a valid draft, continue editing a new draft, or restore the default template.
73. As Registration Staff, printing an A4 prescription uses the published template version consistently and preserves existing queue idempotency.
74. As an operator on a touch device or laptop, all new station controls are keyboard accessible, have visible focus, meet 44×44 touch targets, and remain legible in bright camp conditions.

## Implementation Decisions

1. **Architecture boundary.** Preserve the queue lifecycle `registered → waiting → seen`. Clinical transcription and fulfilment are post-seen records and never become a queue state. The paper prescription remains the prescribing source; the database copy is explicitly labeled an operational transcription.
2. **Role model.** Add the append-only database role value `clinical_operator` and a matching application role. Keep Registration Staff checks separate. Introduce a dedicated clinical authorization predicate. Do not broaden an existing camp-crew alias until every registration RPC caller has been audited and switched to the narrower Registration Staff predicate.
3. **Least privilege.** Clinical lookup and mutations use security-definer operations with explicit role and state checks plus least-privilege RLS. Registration Staff receive no clinical-table policies. Clinical Operators receive exact-lookup/current-person access only, not list or export policies. Admin retains audited review/export/correction access.
4. **Trusted eligibility.** Every clinical read or mutation rechecks that its Registration is `seen`. Starting the first transcription creates the trusted condition that blocks undo-mark-seen. Client routing and disabled buttons are usability only, never authorization.
5. **Phone-first registration.** Desk registration validates a normalized 10-digit Indian mobile before enabling either camera or USB Aadhaar capture. Blank, malformed, and ten-identical-digit values fail. Phone is non-unique and absent from identity and duplicate keys.
6. **Scan provenance.** Volunteer registration requires a valid Aadhaar scan payload and records scanned provenance. The manual RPC is callable only by Team Lead/admin, requires a reason and recorded failed-attempt count of at least three, and writes actor/time/provenance fields. The attempt count is operational evidence; role authorization, audit, and leaderboard exclusion are the anti-abuse boundaries.
7. **Scanner handling.** Treat the USB Aadhaar scanner as a keyboard-wedge device, buffer its rapid input, and submit on its terminator without sending partial payloads. Keep it restricted to the phone-first Aadhaar step. Camera Patient QR scan and exact registration-number entry remain the Clinical Desk lookup methods.
8. **Duplicate behavior.** Preserve the Aadhaar-derived Person hard identity rule and same-name-and-age secondary warning. Remove phone-only matching from likely-duplicate behavior. A manual exception cannot override an existing Aadhaar-derived Person.
9. **Immutable leaderboard attribution.** Competitive metrics derive from the Registration's original registrar and provenance, never from later action actors. Eligible count is one distinct Registration at most. Manual exceptions are excluded. Walk-ins are not excluded.
10. **Leaderboard phase.** Determine pre-camp versus live-camp using the earliest Camp Day in Asia/Kolkata. Before that calendar day, order by eligible Registered count. From that day onward, order by eligible Seen count, with Registered shown second. Return both counts from the canonical KPI boundary so UI surfaces cannot redefine them independently.
11. **Clinical record shape.** Store one current operational transcription per Registration with automatic author/time attribution and fields for diagnosis options/Other, blood sugar, BP, remarks/advice, and medicines. Store Specs and OT structured detail only when selected. Validate bounded text, numeric ranges, eye values, and mutually coherent required fields on the server.
12. **Independent fulfilment items.** Represent Medicine, Specs, and OT as independent items with one current outcome per Registration and an append-only event history. Medicine permits `fulfilled`, `not_available`, `not_required`; Specs and OT permit `fulfilled`, `deferred`, `not_required`. Constrain invalid kind/outcome combinations in the database.
13. **Lock and corrections.** Before any item outcome, the current transcription may be updated. The first outcome atomically locks it. Subsequent clinical changes append reasoned corrections with author/time and changed values; they do not rewrite the original snapshot. Admin and Clinical Operator may correct clinical data, but only admin may reverse a completed fulfilment transition.
14. **Concurrency and idempotency.** Outcome transitions, locking, slip issuance, replacement, reprint eligibility, and follow-up fulfilment execute transactionally with row locking or equivalent conflict protection. Repeating the same request returns the existing result. Competing incompatible transitions return a clear conflict and preserve the winner.
15. **Deferral readiness.** Specs defer atomically reads complete Specs date/venue settings; OT defer reads complete OT date/venue settings. Missing settings reject only that outcome. A successful transaction stores a snapshot rather than a live reference to editable settings.
16. **Slip records.** Store a stable slip reference plus monotonically increasing versions, service kind, issue snapshot, creator/time, active/cancelled/fulfilled validity, and replacement linkage. There is at most one active version per deferred item. Reprint reads the active version without creating events; fulfilment disables valid reprint while preserving history.
17. **58 mm print output.** Render separate Specs and OT documents for 58 mm thermal paper with a bounded printable width, high-contrast typography, wrap-safe venue text, and a Patient QR sized for reliable rescanning. The output must contain only the approved minimal fields. Browser print CSS and generated PDF geometry must agree.
18. **Follow-up lookup.** Reuse exact Patient QR/registration lookup to return only unresolved items belonging to that Person. Historical transcription is read-only. A later fulfilment adds an event and attribution; it does not modify the original defer/unavailable event.
19. **Retention and privacy.** Retain clinical, fulfilment, correction, and slip audit records across camps. Archive is a reversible visibility control, not deletion. Do not cache clinical responses for public use, include them in public status payloads, log field values, or persist them in browser offline storage.
20. **Template versions.** Keep immutable published A4 template versions and a separate editable draft. Registration printing resolves one published version for a document. Publish only after schema validation and one-page render validation; restore-default creates/publishes a new valid version rather than deleting history.
21. **Structured editor.** Use an ordered set of approved blocks, bounded height choices, editable labels/visibility where allowed, and a protected identity/registration/QR block. Do not implement arbitrary coordinates, freeform HTML, or unrestricted canvas behavior.
22. **Sponsor assets.** Validate MIME type and decoded image content, enforce 2 MB per asset, generate managed object keys, and serve assets from the application's controlled storage path. Reject SVG, data URLs, and remote URLs. Removing an asset from a draft does not break an already published version.
23. **Migration discipline.** Implement append-only forward migrations from the current migration head, including role enum, tables, constraints, indexes, policies, functions, and grants. Do not edit old migrations or restore retired doctor/counter schemas wholesale. Verify clean replay, upgrade from current state, and migration readiness metadata.
24. **Rollout sequence.** Deliver in reversible gates: role/schema foundations; phone/scan provenance and leaderboard integrity; Clinical Desk transcription/outcomes; deferred slips and follow-up; template editor/assets; integrated hardware, print, privacy, accessibility, and production-readiness verification.
25. **Observability.** Audit authorization-relevant events and structured failure reasons without clinical values or Aadhaar payloads. Track manual-registration rate, failed deferrals caused by missing settings, slip print/reprint failures, and outcome conflicts so operations can detect misuse or station problems.

## Testing Decisions

1. **Database integration is the primary seam** for role/RLS denial, seen eligibility, phone/provenance enforcement, manual-exception audit and exclusion, immutable leaderboard attribution, item-kind state constraints, lock/correction behavior, deferral snapshots, slip version uniqueness, follow-up fulfilment, concurrency, and idempotency.
2. **Route and component tests** cover phone-first enablement, USB buffer parsing, three-attempt escalation, role-specific payload validation, exact Patient lookup, required conditional clinical fields, outcome error mapping, draft template validation, sponsor-file rejection, and print handoff.
3. **Playwright role journeys** cover Volunteer scanned registration with a shared phone, Volunteer manual-entry denial, Team Lead audited fallback, pre-camp and live-camp leaderboard changes, Clinical Operator seen-only transcription, each item outcome, dual deferral, correction/replacement, historical follow-up, admin review, and denial across every adjacent role.
4. **A4 print tests** retain the existing one-page PDF assertion and add published-template variants with maximum approved blocks, long labels, and multiple sponsor assets.
5. **58 mm print tests** assert document width, privacy-minimized content, separate Specs/OT output, long-name and long-venue wrapping, QR presence/decodability, active-version reprint, cancelled-version denial, and zero duplicate defer events.
6. **Accessibility tests** cover keyboard operation, focus order, visible focus, labels/errors, 44×44 targets, responsive overflow, reduced motion, and high-contrast station states for registration, Clinical Desk, follow-up, and template editing.
7. **Security/privacy tests** prove clinical fields do not appear in public status responses, Registration Staff queries, client logs, analytics events, caches, or offline storage; prove unsafe sponsor uploads and direct policy bypasses fail.
8. **Migration tests** perform a clean database replay and an upgrade from the current head, then verify enum values, grants, RLS, constraints, indexes, functions, and readiness checks.
9. **Physical acceptance is mandatory** for the chosen USB scanner and thermal printer. Test representative Aadhaar Secure QR cards end to end on the camp laptop, including long payloads and failure behavior. Print and rescan both 58 mm slip variants on the intended device. Automated browser tests cannot substitute for this evidence.
10. **Integrated completion gate** runs formatting, lint, type checking, unit tests, database tests, production build, JavaScript budget, role-aware end-to-end tests, environment checks, and a final requirements traceability review. Skipped database suites or untested physical hardware do not count as completion.

## Out of Scope

- A doctor login, doctor-authored digital prescription, or replacement of the signed paper prescription.
- Restoring the retired counter operator, pharmacy counter, treatment-order queue, OT capacity, or doctor-station workflow.
- A fourth patient queue state or changing the meaning of `registered`, `waiting`, or `seen`.
- Inventory, stock decrementing, medicine catalog management, purchasing, or automated availability decisions.
- SMS/WhatsApp automation for deferred services or medicine follow-up.
- Phone OTP, phone uniqueness, household accounts, or using phone as patient identity.
- Aadhaar signature verification, OTP eKYC, demographic API lookup, or selecting a specific scanner vendor/model.
- Volunteer manual registration, Clinical Operator registration, or role sharing.
- Broad Clinical Operator patient search, cohort filtering, analytics, or bulk export.
- Clinical PHI on the public patient status page.
- Offline storage or synchronization of clinical data.
- A free-position design canvas, arbitrary HTML/CSS, SVG sponsor uploads, or remote sponsor URLs.
- Automatic hard deletion of clinical history before a separately reviewed legal/privacy retention policy exists.
- General-purpose document management or editing of non-prescription print artifacts.

## Further Notes

- ADR 0009 records the deliberate exception to ADR 0008: the live doctor desk remains print/mark-seen only, while a separate post-doctor role stores an operational transcription. This does not revive the previous doctor/counter architecture.
- Earlier post-doctor work is useful only as schema and test prior art. The new implementation should reuse proven concepts such as independent item outcomes and append-only amendments, but must not restore unused role splits, stock/capacity workflows, or SMS automation.
- “2 inch” is standardized here as 58 mm thermal paper. Exact printer margins vary, so the selected device and browser/driver combination remain an explicit deployment acceptance gate.
- Keyboard-wedge compatibility does not prove Aadhaar compatibility. The chosen scanner must demonstrate complete capture and parsing of representative Aadhaar Secure QR payloads before procurement or rollout.
- Clinical field labels and ranges should be reviewed once by the camp's authorized clinical owner before production enablement; this is a terminology/validation review, not a new doctor workflow.
- The current full verification pipeline is the governing software gate. Database-backed behavior must not be approved from unit tests alone.
- Relevant prior GitHub history includes the retired post-doctor journey and prescription/order work, the 58 mm desk-slip print precedent, and the later cleanup that established the current three-state desk. Treat those issues as historical context, not as permission to broaden this scope.
