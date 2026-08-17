# SMS is Devanagari-only and link-free; the status token is retired

---
Status: accepted
---

Every outbound SMS was Hinglish in Latin script, and the registration message
embedded a `/s/<token>` status link. Camp patients read Devanagari. They do
not read Latin, and a URL is not a thing they can use at a camp. The
passwordless status page and the public lookup form existed so a patient could
recover that link; the recovery path staff actually use is name-search and
Aadhaar re-scan. Keeping the token column "just in case" would leave a public
surface, a grant, and a PII path that nothing legitimate calls.

**SMS is Hindi in Devanagari, with no URL in any template.** Three DLT
templates: registration (number, camp date, venue), camp-day reminder (same
shape), and one deferral template whose service-name variable is spectacles or
operation, used at slip issue and again the day before. Digits stay ASCII.
Self-registration still sends no SMS; the on-screen receipt is the
registration number, patient QR, camp day, and venue. The Patient QR on the
prescription sheet stays — it is a staff-scan path, not a status token.

**The status token is removed.** The status page, the lookup form, the
rate-limit routes, `patient_status_by_token`, and the token column go. Do not
reintroduce a public patient-facing route, a status token, or a grant on a
token-resolution RPC. This supersedes
[ADR 0002](0002-patient-lookup-is-not-authentication.md).

Dropping the column and the RPC is an **explicitly authorised irreversible
migration**, on the stated basis that no real camp has run and production
holds test data only. It mirrors the one-time exception of migration
`20260728119000` and **sets no precedent**. Once real camp data exists,
removals must archive rather than drop.

Rejected: keep the link and accept a mixed-script message. The link is
unreadable to the audience and is the only reason the public token surface
exists. Rejected: keep the token dormant. A dormant public grant is still a
grant; unused PII paths rot into incidents.
