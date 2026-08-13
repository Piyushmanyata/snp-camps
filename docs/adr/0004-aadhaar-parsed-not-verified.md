# Aadhaar QR is parsed and trusted, not cryptographically verified

---
Status: accepted
---

Self-registration previously required Aadhaar eKYC with an OTP, which is an SMS
dependency we are removing, and which was dark unless an eKYC provider was configured.
We replace it with a plain scan of the QR printed on the Aadhaar card: parse the payload,
extract name, gender, date of birth, address and last-4, and **assume the card is
authentic**. No UIDAI signature check is performed.

## Considered options

- **Verify the UIDAI signature offline** using the existing `aadhaar-verifier.ts`.
  Rejected as unnecessary ceremony for a free eye camp: a forged card gains the holder a
  free eye examination, which is not a threat worth defending against.
- **Keep eKYC OTP.** Rejected: it is an SMS dependency, requires provider configuration,
  and does not deliver the "scan the card" experience that was asked for.

## Consequences

- `aadhaar-verifier.ts` and the certificate-governance machinery become dead code and
  should be removed rather than left to imply a guarantee we no longer make.
- The eKYC OTP path (`aadhaar-kyc.ts`, `aadhaar-kyc-session.ts`, `/api/aadhaar-kyc/*`) is
  retired along with it.
- **The duplicate key changes.** `hashAadhaar()` needs all 12 digits, which only eKYC
  supplied; the QR yields last-4 only. The key becomes
  `HMAC(last4 + normalised name + DOB + gender)`, hard-unique globally. This is stricter
  as an identifier than the old `(last4, name)` rule, so it blocks *fewer* innocent
  collisions while still catching the same card scanned twice.
- The glossary term **Aadhaar verified** no longer means what it said and is renamed —
  the system now records only that details came from a scanned card, not that identity
  was confirmed.
- A scanned card proves the card is real, not that the presenter is its holder. Someone
  can self-register a relative from a photo of their card. Accepted: the desk sees the
  person on camp day, and global one-per-Aadhaar uniqueness still bounds abuse.
