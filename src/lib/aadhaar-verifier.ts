/**
 * Offline Cryptographic Aadhaar QR Signature Verifier (#98).
 * Strictly performs no network requests. Verifies RSA signatures of Aadhaar QR payloads
 * against a bundled public key certificate.
 */

import {
  AADHAAR_CERTIFICATE,
  type AadhaarCertificateMetadata,
} from "./aadhaar-cert";
import { createVerify } from "crypto";

export type VerificationResult = {
  isVerified: boolean;
  provenance: "card_verified" | "self_declared";
  error?: string;
};

export type VerifyOptions = {
  now?: Date;
  certificate?: AadhaarCertificateMetadata;
};

/**
 * Verify RSA-SHA256 signature of an Aadhaar QR payload against the bundled certificate.
 */
export function verifyAadhaarQrSignature(
  rawPayload: string | Uint8Array,
  optionsOrNow?: VerifyOptions | Date,
): VerificationResult {
  const options: VerifyOptions =
    optionsOrNow instanceof Date ? { now: optionsOrNow } : optionsOrNow || {};
  const now = options.now || new Date();
  const cert = options.certificate || AADHAAR_CERTIFICATE;

  // 1. Check Certificate Expiry
  const expiryDate = new Date(cert.expiresAt);
  if (isNaN(expiryDate.getTime()) || now.getTime() > expiryDate.getTime()) {
    return {
      isVerified: false,
      provenance: "self_declared",
      error:
        "Signature verification failed or certificate expired. Please enter details manually.",
    };
  }

  if (!rawPayload) {
    return {
      isVerified: false,
      provenance: "self_declared",
      error: "Invalid or empty payload.",
    };
  }

  // 2. Extract signed content and signature bytes
  let signedDataBuffer: Buffer | Uint8Array | null = null;
  let signatureBuffer: Buffer | Uint8Array | null = null;

  if (typeof rawPayload === "string") {
    const trimmed = rawPayload.trim();

    // XML format with signature / sig attribute
    const xmlSigMatch = trimmed.match(/\s(?:signature|sig)="([^"]+)"/i);
    if (xmlSigMatch) {
      const sigBase64 = xmlSigMatch[1];
      const dataStr = trimmed
        .replace(/\s(?:signature|sig)="[^"]+"/gi, "")
        .trim();
      signedDataBuffer = Buffer.from(dataStr, "utf8");
      signatureBuffer = Buffer.from(sigBase64, "base64");
    } else if (trimmed.includes("|")) {
      // Delimited format: "payload|signature"
      const lastPipeIndex = trimmed.lastIndexOf("|");
      const dataStr = trimmed.slice(0, lastPipeIndex);
      const sigBase64 = trimmed.slice(lastPipeIndex + 1);
      signedDataBuffer = Buffer.from(dataStr, "utf8");
      signatureBuffer = Buffer.from(sigBase64, "base64");
    } else if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      // JSON format
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.signature && typeof parsed.signature === "string") {
          const sigBase64 = parsed.signature;
          let dataStr: string;
          if (parsed.data) {
            dataStr =
              typeof parsed.data === "string"
                ? parsed.data
                : JSON.stringify(parsed.data);
          } else {
            const copy = { ...parsed };
            delete copy.signature;
            dataStr = JSON.stringify(copy);
          }
          signedDataBuffer = Buffer.from(dataStr, "utf8");
          signatureBuffer = Buffer.from(sigBase64, "base64");
        }
      } catch {
        /* fallthrough */
      }
    }
  } else if (rawPayload instanceof Uint8Array) {
    // Binary payload format: check if payload has delimited header or last 256 bytes RSA signature
    if (rawPayload.length > 256) {
      signedDataBuffer = rawPayload.subarray(0, rawPayload.length - 256);
      signatureBuffer = rawPayload.subarray(rawPayload.length - 256);
    }
  }

  if (!signedDataBuffer || !signatureBuffer || signatureBuffer.length === 0) {
    return {
      isVerified: false,
      provenance: "self_declared",
      error:
        "Signature verification failed or certificate expired. Please enter details manually.",
    };
  }

  // 3. Cryptographic Verification using RSA-SHA256
  try {
    const verifier = createVerify("SHA256");
    verifier.update(signedDataBuffer);
    const isValid = verifier.verify(cert.publicKeyPem, signatureBuffer);

    if (isValid) {
      return {
        isVerified: true,
        provenance: "card_verified",
      };
    }
  } catch {
    // Return explicit verification failure
  }

  return {
    isVerified: false,
    provenance: "self_declared",
    error:
      "Signature verification failed or certificate expired. Please enter details manually.",
  };
}
