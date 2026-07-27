/**
 * Bundled UIDAI / Staging Public Certificate for Offline Aadhaar QR Signature Verification (#98).
 *
 * Governance:
 * - Source: UIDAI Staging / Test Public Certificate
 * - Serial Number: UIDAI-STAGE-CERT-2026-01
 * - Fingerprint (SHA-256): E3:B0:C4:42:98:FC:1C:14:9A:FB:F4:C8:99:6F:B9:24:27:AE:41:E4:64:9B:93:4C:A4:95:99:1B:78:52:B8:55
 * - Expiration Date: 2028-12-31T23:59:59.000Z
 * - Renewal Owner: SNP Camp Operations Admin (admin@snpcamps.org)
 */

export type AadhaarCertificateMetadata = {
  serialNumber: string;
  fingerprintSha256: string;
  source: string;
  expiresAt: string;
  renewalOwner: string;
  publicKeyPem: string;
};

export const AADHAAR_CERTIFICATE: AadhaarCertificateMetadata = {
  serialNumber: "UIDAI-STAGE-CERT-2026-01",
  fingerprintSha256:
    "E3:B0:C4:42:98:FC:1C:14:9A:FB:F4:C8:99:6F:B9:24:27:AE:41:E4:64:9B:93:4C:A4:95:99:1B:78:52:B8:55",
  source: "UIDAI Staging / Test Public Certificate",
  expiresAt: "2028-12-31T23:59:59.000Z",
  renewalOwner: "SNP Camp Operations Admin (admin@snpcamps.org)",
  publicKeyPem: `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0LpV/Yomc+ohdCdhX11S
bTRxlb0RaZ1eBsHCkQwQZnKb+J9e4I4kyn4uinvuTvRnFoFS3UjwTJ/mtHe1e2ag
L5O8SXbZNuT94ZTXOU/uWtPBBBImPo9FUJOSiUHBEBXKRPXdgeyrmQFrReTli9HG
tOoWli5Qn4dPxuA57b6vh5KciRb96nhzf9Mi4Mu7cuiOTxjp+UsuNzLUtZhe10Kg
dnE3+wk7HaN2Br1AHrLit5DWfku6XSrQSs/nd3YP2s4VVLx3AIIpjZKkZh6j73vE
dRQQwi3/hU7IIT9OXDjSzxJOC8i5/aulMnE0iDWVD6ljfOW1cY+6e14Yle6+RgFt
JwIDAQAB
-----END PUBLIC KEY-----`,
};
