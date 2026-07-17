/** Absolute origin for patient QR links. Prefer NEXT_PUBLIC_SITE_URL. */
function resolveOrigin(origin?: string | null): string {
  const base =
    (typeof process !== "undefined" && process.env.NEXT_PUBLIC_SITE_URL) ||
    origin ||
    (typeof window !== "undefined" ? window.location.origin : "");
  return String(base || "").replace(/\/$/, "");
}

/** Direct print form URL (staff). Opening joins the queue. */
export function patientPrintUrl(patientId: string, origin?: string | null): string {
  const clean = resolveOrigin(origin);
  if (!clean) return patientId;
  return `${clean}/print/${patientId}`;
}

/**
 * Staff-scan QR payload. Uses /patient/enter so staff cameras route by status:
 * registered → print, waiting/seen → desk assign.
 */
export function patientScanUrl(patientId: string, origin?: string | null): string {
  const clean = resolveOrigin(origin);
  if (!clean) return patientId;
  return `${clean}/patient/enter/${patientId}`;
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
