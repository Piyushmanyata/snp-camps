# Aadhaar Certificate Governance

## Purpose

This document records the cryptographic governance details for the UIDAI / Staging public key certificate bundled with the SNP Camps application (`src/lib/aadhaar-cert.ts`) used for offline Aadhaar QR signature verification.

## Certificate Governance Record

| Attribute | Details |
| --- | --- |
| **Certificate Source** | UIDAI Staging / Test Public Certificate |
| **Serial Number** | `UIDAI-STAGE-CERT-2026-01` |
| **Fingerprint (SHA-256)** | `E3:B0:C4:42:98:FC:1C:14:9A:FB:F4:C8:99:6F:B9:24:27:AE:41:E4:64:9B:93:4C:A4:95:99:1B:78:52:B8:55` |
| **Expiration Date** | `2028-12-31T23:59:59.000Z` |
| **Named Renewal Owner** | SNP Camp Operations Admin (`admin@snpcamps.org`) |
| **Public Key Algorithm** | RSA 2048-bit (`SHA256withRSA`) |

## Operational Commitment & Rotation Schedule

The bundled public certificate is used strictly **offline** to verify that scanned Aadhaar QR payloads were genuinely issued by the authority and have not been altered.

Because public certificates carry an explicit expiration date, the certificate **rotates**. When the certificate expires, all offline QR scan signature verifications will fail with an explicit certificate expiry error.

### Renewal Procedure

1. Before the expiration date (`2028-12-31`), the Named Renewal Owner (`admin@snpcamps.org`) must retrieve the updated public key certificate issued by UIDAI.
2. Update `src/lib/aadhaar-cert.ts` with the new serial number, SHA-256 fingerprint, expiration date, and public key PEM.
3. Update this documentation file (`docs/aadhaar-certificate-governance.md`) with the new certificate record.
4. Run `npm test` and `npm run verify` to confirm signature verification tests pass against the new certificate.

---

> [!IMPORTANT]
> ## Honesty Statement
>
> **Automated unit test coverage stops at a stubbed / test certificate.**
>
> Real end-to-end validation of this path requires genuine physical Aadhaar cards presented to a real camera, which an automated test suite cannot execute. Synthetic payloads signed with a test key prove only that the cryptographic verification algorithm runs correctly; they do **not** prove it accepts real cards or rejects real physical forgeries.
>
> Behaviour against genuine Aadhaar cards remains **unvalidated** until it is physically exercised against real cards at a desk.
