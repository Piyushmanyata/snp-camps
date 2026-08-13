/**
 * Screen-level clinical helpers.
 *
 * The browser no longer mirrors `assert_valid_clinical_data`: the database is
 * the no (ADR 0015). A second copy of the save rules disagreed with Postgres on
 * diagnoses and swallowed the real refusal behind "try again", so it is gone.
 * Empty boxes are the inputs' own `required` / `pattern`; every other refusal
 * comes back from the database and is shown in Hinglish.
 *
 * What remains is the one thing the database deliberately does not decide: an
 * amendment that changes nothing. That is a screen hint, not a JSON-equality
 * check in SQL.
 */

import {
  diagnosesEqual,
  flattenDiagnoses,
  normalizeDiagnoses,
} from "@/lib/clinical-diagnoses";

function normalizeTranscriptionForCompare(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = { ...(value as Record<string, unknown>) };
  if ("diagnoses" in record) {
    // Shared flattener so legacy array ↔ {options,other} is not a change.
    record.diagnoses = flattenDiagnoses(record.diagnoses);
  }
  return record;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
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
