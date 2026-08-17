
import {
  diagnosesEqual,
  flattenDiagnoses,
  normalizeDiagnoses,
} from "@/lib/clinical-diagnoses";

function normalizeTranscriptionForCompare(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = { ...(value as Record<string, unknown>) };
  if ("diagnoses" in record) {
    record.diagnoses = flattenDiagnoses(record.diagnoses);
  }
  return record;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      // Code-point order, not localeCompare: collation varies with the runtime's
      // ICU locale, so identical records could compare unequal across
      // server and browser and register as a spurious amendment.
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => [key, sortKeys(child)]),
  );
}

export function isSameTranscription(a: unknown, b: unknown): boolean {
  return (
    JSON.stringify(sortKeys(normalizeTranscriptionForCompare(a))) ===
    JSON.stringify(sortKeys(normalizeTranscriptionForCompare(b)))
  );
}

export { diagnosesEqual, normalizeDiagnoses };
