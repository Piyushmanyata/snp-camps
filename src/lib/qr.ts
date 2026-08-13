/**
 * Patient QR codes are for **camp staff scan only**.
 * Never used for patient login — patients have no app login; status is
 * passwordless via /s/<token> (not this QR).
 */

const UUID_RE =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const REG_NO_MAX = 2_147_483_647;

const IS_PATIENT_UUID_RE = new RegExp(`^${UUID_RE}$`, "i");
const SNP_SCHEME_RE = new RegExp(`^snp:(${UUID_RE})$`, "i");
const PATH_MATCH_RE = new RegExp(
  `\\/(?:print|patient\\/enter|p)\\/(${UUID_RE})(?:[/?#]|$)`,
  "i",
);
const QUERY_MATCH_RE = new RegExp(
  `[?&](?:id|scan|checkin)=(${UUID_RE})`,
  "i",
);
const ANY_UUID_RE = new RegExp(UUID_RE, "i");

/** Parse a database-backed registration number without allowing overflow. */
export function parseRegistrationNumber(
  raw: string | number | null | undefined,
): number | null {
  if (raw == null) return null;

  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw > 0 && raw <= REG_NO_MAX
      ? raw
      : null;
  }

  if (typeof raw !== "string" || raw.length > 512) return null;

  const digits = raw.replace(/\D/g, "");
  if (!digits || digits.length > 10) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) && value > 0 && value <= REG_NO_MAX
    ? value
    : null;
}

export function isPatientUuid(id: string): boolean {
  if (!id || typeof id !== "string" || id.length > 512 || !id.includes("-")) {
    return false;
  }
  const trimmed = id.trim();
  if (trimmed.length !== 36) return false;
  return IS_PATIENT_UUID_RE.test(trimmed);
}

export function resolveOrigin(origin?: string | null): string {
  if (!origin || typeof origin !== "string") return "";
  const trimmed = origin.trim();
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

/**
 * Staff-scan QR payload (short path = denser, more reliable paper scan).
 * Opening as staff: registered → print · seen → desk assign.
 * Opening as public: show-at-desk message (no login).
 */
export function patientScanUrl(
  patientId: string,
  origin?: string | null,
): string {
  const id = patientId.trim().toLowerCase();
  if (!isPatientUuid(id)) return patientId.trim();
  // Compact scheme = larger modules on paper, faster / blur-tolerant scans.
  // Full /p/<uuid> URLs still parse if someone embeds them.
  void origin;
  return `snp:${id}`;
}

export function patientPrintUrl(
  patientId: string,
  origin?: string | null,
): string {
  const id = patientId.trim().toLowerCase();
  if (!isPatientUuid(id)) return patientId.trim();
  const base = resolveOrigin(origin);
  return base ? `${base}/print/${id}` : `/print/${id}`;
}

/**
 * Extract patient UUID from scanned QR text.
 * Accepts: bare UUID, /p/, /patient/enter/, /print/, ?id=, snp:uuid, legacy ?t=
 */
export function parsePatientIdFromQr(raw: string): string | null {
  if (!raw || typeof raw !== "string" || raw.length > 512) return null;

  const text = raw.trim();
  if (!text || !text.includes("-")) return null;

  // Exact 36-char length: test IS_PATIENT_UUID_RE
  if (text.length === 36) {
    if (IS_PATIENT_UUID_RE.test(text)) {
      return text.toLowerCase();
    }
  }

  // Starts with snp:/SNP: compact scheme
  if (text.startsWith("snp:") || text.startsWith("SNP:")) {
    const snp = text.match(SNP_SCHEME_RE);
    if (snp?.[1]) return snp[1].toLowerCase();
  }

  // Includes /: path URL /print/<uuid>, /patient/enter/<uuid>, /p/<uuid>
  if (text.includes("/")) {
    const pathMatch = text.match(PATH_MATCH_RE);
    if (pathMatch?.[1]) return pathMatch[1].toLowerCase();
  }

  // Includes ? or &: query ?id=uuid or legacy scan/checkin
  if (text.includes("?") || text.includes("&")) {
    const qMatch = text.match(QUERY_MATCH_RE);
    if (qMatch?.[1]) return qMatch[1].toLowerCase();
  }

  // Last resort: any UUID substring in a longer string (camera misreads URL)
  if (text.length <= 200) {
    const any = text.match(ANY_UUID_RE);
    if (any?.[0]) return any[0].toLowerCase();
  }

  return null;
}
