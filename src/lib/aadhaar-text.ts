
const NON_LATIN_SCRIPT = new RegExp(
  "[^\\u0000-\\u007f\\u00a0-\\u024f\\s.,'-]",
  "u",
);

export function isNonLatinText(text: string | null | undefined): boolean {
  if (!text) return false;
  return NON_LATIN_SCRIPT.test(text);
}

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

  // day <= 31 alone accepts 31/02. A bogus DOB reaches derivePersonDuplicateKey
  // and is stored, so the same card rescanned with a real DOB keys differently
  // and registers a second person. Round-trip to reject impossible calendar days.
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    return null;
  }

  return `${year.toString().padStart(4, "0")}-${month
    .toString()
    .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}
