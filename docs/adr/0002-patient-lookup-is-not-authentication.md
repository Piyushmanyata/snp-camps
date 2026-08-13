# Patient self-service lookup is token resolution, not authentication

---
Status: accepted
---

Patients need to reach their own registration number, patient QR, queue position and
treatment status without visiting the desk. Issue #59 retired patient Supabase Auth
entirely, and the passwordless status link (`/s/<token>`) already carries an
un-guessable per-patient token.

We therefore expose a **Patient lookup** form that accepts registration number + date
of birth and, on success, redirects to that patient's existing `/s/<token>` page. No
Supabase Auth session is created, no patient-facing RLS policy is added, and the #59
least-privilege invariant and its `security-invariants` test survive untouched.

## Considered options

- **Real patient accounts** with reg-no + DOB as credentials. Rejected: registration
  numbers come from a single global sequence and are printed on the desk slip, so they
  are enumerable. Pairing an enumerable identifier with a low-entropy secret to guard
  prescriptions is a PHI exposure we are not willing to take, and it would require
  reintroducing the entire patient-auth surface that #59 deliberately removed.
- **Status link only, no lookup form.** Rejected: a patient who loses the link has no
  self-service recovery and must return to the desk.

## Consequences

- The lookup form is an enumeration target and MUST be rate-limited per IP with
  lockout after repeated failures. It is the only public endpoint that maps a guessable
  identifier to a token.
- Patients registered manually at the desk have no DOB (see ADR 0004) and therefore
  cannot use the lookup. Their route to status is the patient QR printed on their slip.
- `/s/<token>` grows from a queue-status page into the patient's full self-service view
  (patient QR, registration number, live queue position, treatment order status). The
  `patient_status_by_token` RPC must keep stripping sensitive PII as it does today.
