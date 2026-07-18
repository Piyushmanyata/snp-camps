/**
 * Patient QR codes are for **staff scan only** (volunteer / doctor / admin).
 * Never used for patient login — patients sign in with reg no + password.
 */

/** Absolute origin for QR links. Prefer NEXT_PUBLIC_SITE_URL. */
export function resolveOrigin(origin?: string | null): string {
  const base =
    (typeof process !== "undefined" && process.env.NEXT_PUBLIC_SITE_URL) ||
    origin ||
    (typeof window !== "undefined" ? window.location.origin : "");
  return String(base || "").replace(/\/$/, "");
}

const UUID_RE =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export function isPatientUuid(id: string): boolean {
  return new RegExp(`^${UUID_RE}$`, "i").test(id.trim());
}

/** Direct print form URL (staff). Opening joins the queue. */
export function patientPrintUrl(
  patientId: string,
  origin?: string | null,
): string {
  const id = patientId.trim().toLowerCase();
  const clean = resolveOrigin(origin);
  if (!clean) return id;
  return `${clean}/print/${id}`;
}

/**
 * Staff-scan QR payload (short path = denser, more reliable paper scan).
 * Opening as staff: registered → print · waiting/seen → desk assign.
 * Opening as patient/public: qr-help (no login).
 */
export function patientScanUrl(
  patientId: string,
  origin?: string | null,
): string {
  const id = patientId.trim().toLowerCase();
  if (!isPatientUuid(id)) return patientId.trim();
  const clean = resolveOrigin(origin);
  // Bare UUID still parses in the in-app scanner when site URL is missing.
  if (!clean) return id;
  return `${clean}/p/${id}`;
}

/**
 * Extract patient UUID from scanned QR text.
 * Accepts: bare UUID, /p/, /patient/enter/, /print/, ?id=, snp:uuid, legacy ?t=
 */
export function parsePatientIdFromQr(decoded: string): string | null {
  const text = decoded.trim();
  if (!text) return null;

  // snp:<uuid> compact scheme (optional future / offline tags)
  const snp = text.match(new RegExp(`^snp:(${UUID_RE})$`, "i"));
  if (snp?.[1]) return snp[1].toLowerCase();

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

  // query ?id=uuid or legacy scan/checkin
  const qMatch = text.match(
    new RegExp(`[?&](?:id|scan|checkin)=(${UUID_RE})`, "i"),
  );
  if (qMatch?.[1]) return qMatch[1].toLowerCase();

  // Last resort: any UUID substring in a longer string (camera misreads URL)
  const any = text.match(new RegExp(UUID_RE, "i"));
  if (any?.[0] && text.length <= 200) return any[0].toLowerCase();

  return null;
}
