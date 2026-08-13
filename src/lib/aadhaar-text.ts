/**
 * Dependency-free Aadhaar text helpers.
 *
 * Deliberately separate from `aadhaar-qr.ts`. That module pulls in pako,
 * fast-xml-parser and zod, and the registration screens need only these two
 * tiny pure functions at render time — importing them from the parser dragged
 * ~200KB gzipped of decoder dependencies into the eager `/register` and
 * `/self-register` bundles, which the JS budget gate rejects (#71).
 *
 * Nothing here may import anything.
 */

/** Anything outside Basic Latin + Latin-1 Supplement + Latin Extended-A/B. */
const NON_LATIN_SCRIPT = new RegExp(
  "[^\\u0000-\\u007f\\u00a0-\\u024f\\s.,'-]",
  "u",
);

/**
 * Checks if a string contains non-Latin script characters
 * (e.g. Devanagari, Tamil, Telugu, Bengali, Arabic).
 *
 * Drives the "also give a Latin spelling" prompt: printed slips and name search
 * both need Latin text.
 */
export function isNonLatinText(text: string | null | undefined): boolean {
  if (!text) return false;
  return NON_LATIN_SCRIPT.test(text);
}

/**
 * Parse a full DOB string into stable `YYYY-MM-DD`, or null when unparseable.
 * Accepts ISO and day-month-year orders with `-`, `/` or `.` separators.
 *
 * Returns null for a bare year or an age: the Person duplicate key needs a real
 * calendar date, and inventing 1 January for a year-only card would collide
 * every such patient onto the same key.
 */
export function parseDateOfBirth(
  dobStr?: string | number | null,
): string | null {
  if (dobStr == null || typeof dobStr === "number") return null;
  const trimmed = String(dobStr).trim();
  if (!trimmed || /^\d{1,3}$/.test(trimmed)) return null;

  const isoMatch = trimmed.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:T.*)?$/);
  const dmyMatch = trimmed.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);

  let year: number | null = null;
  let month: number | null = null;
  let day: number | null = null;

  if (isoMatch) {
    year = parseInt(isoMatch[1], 10);
    month = parseInt(isoMatch[2], 10);
    day = parseInt(isoMatch[3], 10);
  } else if (dmyMatch) {
    day = parseInt(dmyMatch[1], 10);
    month = parseInt(dmyMatch[2], 10);
    year = parseInt(dmyMatch[3], 10);
  }

  if (
    year === null ||
    month === null ||
    day === null ||
    year < 1875 ||
    year > 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }

  return `${year.toString().padStart(4, "0")}-${month
    .toString()
    .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}
