export type NormalizedDiagnoses = {
  options: string[];
  other: string | null;
};

export function normalizeDiagnoses(
  raw: unknown,
  knownOptions?: readonly string[],
): NormalizedDiagnoses {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const value = raw as Record<string, unknown>;
    if ("options" in value || "other" in value) {
      const options = Array.isArray(value.options)
        ? value.options
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean)
        : [];
      const otherRaw = value.other;
      const other =
        typeof otherRaw === "string" && otherRaw.trim()
          ? otherRaw.trim()
          : null;
      return { options, other };
    }
  }

  const list = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === "string" && raw
      ? [raw]
      : [];

  if (knownOptions) {
    const known = new Set(knownOptions);
    const options: string[] = [];
    const otherParts: string[] = [];
    for (const item of list) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      if (known.has(trimmed) || known.has(item)) options.push(trimmed);
      else otherParts.push(trimmed);
    }
    return {
      options,
      other: otherParts.length ? otherParts.join("; ") : null,
    };
  }

  return {
    options: list.map((item) => item.trim()).filter(Boolean),
    other: null,
  };
}

export function flattenDiagnoses(raw: unknown): string[] {
  const normalized = normalizeDiagnoses(raw);
  const items = [...normalized.options];
  if (normalized.other) items.push(normalized.other);
  return items
    .flatMap((item) => item.split(";"))
    .map((item) => item.trim())
    .filter(Boolean)
    .sort();
}

export function diagnosesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(flattenDiagnoses(a)) === JSON.stringify(flattenDiagnoses(b));
}

// Clinical Desk is Hinglish-only, and this validator is its only caller.
const UNAVAILABLE_REQUIRED =
  "Pehle unavailable dawaiyan likhein, phir Available nahi save karein.";
const MAX_UNAVAILABLE = 12;
const MAX_UNAVAILABLE_LEN = 120;

export function validateUnavailableMedicines(
  list: unknown,
): { ok: true; medicines: string[] } | { ok: false; message: string } {
  if (list == null) {
    return { ok: false, message: UNAVAILABLE_REQUIRED };
  }
  if (!Array.isArray(list)) {
    return { ok: false, message: UNAVAILABLE_REQUIRED };
  }
  if (list.length < 1 || list.length > MAX_UNAVAILABLE) {
    return {
      ok: false,
      message: `1 se ${MAX_UNAVAILABLE} tak unavailable dawaiyan likhein.`,
    };
  }
  const medicines: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") {
      return { ok: false, message: UNAVAILABLE_REQUIRED };
    }
    const trimmed = item.trim();
    if (trimmed.length < 1 || trimmed.length > MAX_UNAVAILABLE_LEN) {
      return {
        ok: false,
        message: `Har dawai ka naam 1 se ${MAX_UNAVAILABLE_LEN} akshar tak rakhein.`,
      };
    }
    medicines.push(trimmed);
  }
  return { ok: true, medicines };
}
