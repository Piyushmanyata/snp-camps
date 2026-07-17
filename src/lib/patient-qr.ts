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

/** QR payload: patient scans → instant login; desk scan still extracts patient id. */
export function patientLoginUrl(
  patientId: string,
  origin?: string | null,
): string {
  const base =
    (typeof process !== "undefined" && process.env.NEXT_PUBLIC_SITE_URL) ||
    origin ||
    "";
  const clean = String(base || "").replace(/\/$/, "");
  const token = signPatientQrToken(patientId);
  if (!clean || !token) {
    // Fall back to print URL so desk scan still works without secret
    return patientPrintUrl(patientId, origin);
  }
  return `${clean}/patient/enter/${patientId}?t=${token}`;
}
