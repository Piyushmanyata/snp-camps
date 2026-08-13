const FORMULA_PREFIX = /^[=+\-@\t\r]/;
const NUMERIC = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

/** Guard operator-authored text against spreadsheet formula injection. */
export function encodeCsvCell(value: string) {
  const safe = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

/**
 * Emit a validated numeric cell bare (so Excel keeps it numeric). Anything that
 * is not a genuine number falls back to the text encoder.
 */
export function encodeCsvNumber(value: unknown): string {
  if (value === null || value === undefined || value === "") return '""';
  const text = typeof value === "number" ? String(value) : String(value).trim();
  if (!text) return '""';
  if (!NUMERIC.test(text)) return encodeCsvCell(text);
  // Reject values that JS would accept but are not spreadsheet-safe bare numbers
  // (e.g. leading zeros for non-zero integers are still numeric text).
  const asNumber = Number(text);
  if (!Number.isFinite(asNumber)) return encodeCsvCell(text);
  return text;
}

/**
 * Emit a plain household phone as quoted digits only. Valid phones are 4–15
 * digits after trim (no tab, no formula-guard apostrophe). Hostile or non-digit
 * values fall through to the ordinary text encoder so the formula guard still
 * applies.
 */
export function encodeCsvPhone(value: string | null | undefined): string {
  if (value == null || value === "") return '""';
  const digits = String(value).trim();
  if (!digits) return '""';
  if (/^\d{4,15}$/.test(digits)) return `"${digits}"`;
  return encodeCsvCell(digits);
}

/** Asia/Kolkata date-time for export cells (never ISO UTC). */
export function formatIstTimestamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

/** UTF-8 BOM + CRLF body for Excel-first downloads. */
export function buildCsvDocument(rows: string[][]): string {
  const body = rows.map((row) => row.join(",")).join("\r\n");
  return `\uFEFF${body}${rows.length ? "\r\n" : ""}`;
}

export function slugForFilename(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[^\w\s-]+/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60) || "camp"
  );
}
