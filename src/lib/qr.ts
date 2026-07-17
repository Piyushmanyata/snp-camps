/** Build the QR payload for a patient print link. Prefer absolute production URL. */
export function patientPrintUrl(patientId: string, origin?: string | null): string {
  const base =
    (typeof process !== "undefined" && process.env.NEXT_PUBLIC_SITE_URL) ||
    origin ||
    (typeof window !== "undefined" ? window.location.origin : "");
  const clean = String(base || "").replace(/\/$/, "");
  if (!clean) return patientId; // UUID alone — scanner accepts it
  return `${clean}/print/${patientId}`;
}

const UUID_RE =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** Extract patient UUID from scanned QR text (URL or bare id). */
export function parsePatientIdFromQr(decoded: string): string | null {
  const text = decoded.trim();
  if (!text) return null;

  // bare UUID
  if (new RegExp(`^${UUID_RE}$`, "i").test(text)) {
    return text.toLowerCase();
  }

  // /print/<uuid>, /patient/enter/<uuid>, /p/<uuid>
  const pathMatch = text.match(
    new RegExp(
      `\\/(?:print|patient\\/enter|p)\\/(${UUID_RE})(?:[/?#]|$)`,
      "i",
    ),
  );
  if (pathMatch?.[1]) return pathMatch[1].toLowerCase();

  // query ?id=uuid
  const qMatch = text.match(new RegExp(`[?&]id=(${UUID_RE})`, "i"));
  if (qMatch?.[1]) return qMatch[1].toLowerCase();

  return null;
}
