import { createHmac, timingSafeEqual } from "crypto";
import { patientPrintUrl } from "@/lib/qr";

function qrSecret(): string {
  return (
    process.env.PATIENT_QR_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    ""
  );
}

/** HMAC token for passwordless patient QR login. Server-only. */
export function signPatientQrToken(patientId: string): string {
  const secret = qrSecret();
  if (!secret) return "";
  return createHmac("sha256", secret)
    .update(`patient-qr:v1:${patientId}`)
    .digest("base64url");
}

export function verifyPatientQrToken(
  patientId: string,
  token: string | null | undefined,
): boolean {
  if (!token) return false;
  const expected = signPatientQrToken(patientId);
  if (!expected || expected.length !== token.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(token));
  } catch {
    return false;
  }
}

/**
 * Staff-scan QR payload (print URL). Patient opening it does not log them in.
 * Kept name for call-site compatibility.
 */
export function patientLoginUrl(
  patientId: string,
  origin?: string | null,
): string {
  return patientPrintUrl(patientId, origin);
}

/** @deprecated use patientPrintUrl / patientLoginUrl (staff scan only) */
export function patientStaffScanUrl(
  patientId: string,
  origin?: string | null,
): string {
  return patientPrintUrl(patientId, origin);
}
