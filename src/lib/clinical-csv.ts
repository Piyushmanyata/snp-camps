const FORMULA_PREFIX = /^[=+\-@\t\r]/;
const NUMERIC = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

export function encodeCsvCell(value: string) {
  const safe = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function encodeCsvNumber(value: unknown): string {
  if (value === null || value === undefined || value === "") return '""';
  const text = typeof value === "number" ? String(value) : String(value).trim();
  if (!text) return '""';
  if (!NUMERIC.test(text)) return encodeCsvCell(text);
  const asNumber = Number(text);
  if (!Number.isFinite(asNumber)) return encodeCsvCell(text);
  return text;
}

export function encodeCsvPhone(value: string | null | undefined): string {
  if (value == null || value === "") return '""';
  const digits = String(value).trim();
  if (!digits) return '""';
  if (/^\d{4,15}$/.test(digits)) return `"${digits}"`;
  return encodeCsvCell(digits);
}

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
