# ADR 0001 — Patient auth via registration number + desk-slip passcode

## Status

**Superseded** (2026-07-26) by GitHub issues **#41** / **#45** — patient
passcode login, public OTP self-registration, and the patient portal were
removed. Patients no longer authenticate in-app; desk registration +
staff-scan QR + passwordless `/s/<token>` status replace this model. Keep this
ADR for history; do not reintroduce desk-slip passcodes without a new ADR.

Previously: Accepted (2026-07-25) — implements GitHub issue #15.

## Context

Registration numbers are sequential integers. Using reg number alone for patient login lets anyone walk the range and open every patient record (name, phone, address, Aadhaar last-4).

Camp field conditions constrain options:

- SMS OTP is not always configured or reliable on the day of camp.
- Many walk-in patients register at a volunteer desk without a verified phone.
- Staff already print a paper desk slip at registration.

A claim-token style secret existed earlier in the product history and was removed during a hardening pass that did not fully replace the open reg-number login path.

## Decision

1. **Primary desk path:** Patient proves identity with **registration number + passcode** printed on the **desk slip**.
2. **Passcode storage:** The passcode is the Supabase Auth password for the synthetic account `reg{N}@patients.snp.local`. Auth stores only a hash; the app never persists plaintext passcodes in the database.
3. **Issue timing:** Desk registration provisions the Auth user and shows the passcode once to staff; the print flow carries it onto the slip via same-tab `sessionStorage` (never via URL query params).
4. **Reissue:** Authenticated staff (admin/volunteer) may reissue a new passcode; the previous value stops working. Lost slips are expected.
5. **Alternative path:** Phone OTP (when SMS is configured) remains valid for self-registration and login; it is not replaced by the slip.
6. **Login API:** `POST /api/patient-login` accepts reg + passcode, rate-limits attempts, returns a single generic failure for wrong reg or wrong passcode (no existence oracle), sets the session, and **never** returns credentials or resets passwords to a shared default.

## Alternatives considered

| Option | Why not chosen |
|--------|----------------|
| **SMS OTP only** | Unreliable / unconfigured at many camps; excludes phone-less walk-ins. Kept as optional alternative, not sole path. |
| **Reg number alone** | Sequential IDs are guessable; enumerates all PHI. Rejected. |
| **App-level `passcode_hash` column separate from Auth** | Duplicates Auth’s password store and reintroduces dual-write bugs. Auth hash is sufficient. |
| **Email magic links** | Patients often lack email; desk is paper-first. |

## Consequences

- Desk slip is **no longer optional** for the reg-number login path; product copy and `CONTEXT.md` treat it as the carrier of the login secret.
- Unauthenticated callers must never receive a password/passcode in any API response (follow-up: #16 retires any remaining credential-returning remnants and migrates legacy accounts that used a shared default password).
- Staff workflow includes “issue/reissue passcode” and “print desk slip” after registration or when a slip is lost.
- E2E and ops must supply a real per-patient passcode (`E2E_PATIENT_PASSWORD` / passcode), not a global default.

## References

- Issue #15 — Patient auth: registration number plus a passcode printed on the desk slip
- Issue #16 — Retire the credential-returning patient-login endpoint (depends on this ADR)
- `CONTEXT.md` — Desk Slip, Passcode, Patient definitions
