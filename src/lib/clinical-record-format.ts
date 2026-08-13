import { normalizeDiagnoses } from "@/lib/clinical-diagnoses";

const HANDLED_KEYS = new Set([
  "diagnoses",
  "bloodSugar",
  "bloodPressure",
  "remarks",
  "medicines",
  "specs",
  "ot",
]);

function isPresent(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  return false;
}

function eyeFieldValues(eye: Record<string, unknown>): string[] {
  return ["sphere", "cylinder", "axis", "vision", "near"].map((field) =>
    String(eye[field] ?? "").trim(),
  );
}

/**
 * Pure formatter for unit tests and ClinicalRecordView.
 * Never emits JSON or "[object Object]".
 */
export function formatClinicalRecordRows(data: unknown): string[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const source = data as Record<string, unknown>;
  const rows: string[] = [];

  if (source.diagnoses != null) {
    // Spec: normalizeDiagnoses(data.diagnoses, []). Empty knownOptions is
    // ignored for the object shape (early return). For legacy flat arrays,
    // omit the template so every stored entry is treated as a chosen option
    // (passing [] would push them all into `other` in clinical-diagnoses).
    const normalized = Array.isArray(source.diagnoses)
      ? normalizeDiagnoses(source.diagnoses)
      : normalizeDiagnoses(source.diagnoses, []);
    let text = normalized.options.join(", ");
    if (normalized.other) {
      text = text
        ? `${text} · Other: ${normalized.other}`
        : `Other: ${normalized.other}`;
    }
    if (text) rows.push(`Diagnosis: ${text}`);
  }

  if (isPresent(source.bloodSugar)) {
    rows.push(`Blood sugar: ${String(source.bloodSugar)}`);
  }
  if (isPresent(source.bloodPressure)) {
    rows.push(`BP: ${String(source.bloodPressure)}`);
  }
  if (isPresent(source.remarks)) {
    rows.push(`Remarks: ${String(source.remarks)}`);
  }
  if (isPresent(source.medicines)) {
    rows.push(`Medicines: ${String(source.medicines)}`);
  }

  if (source.specs && typeof source.specs === "object" && !Array.isArray(source.specs)) {
    const specs = source.specs as Record<string, unknown>;
    const type = String(specs.type ?? "").trim();
    const pd = String(specs.pd ?? "").trim();
    if (type || pd) {
      const parts: string[] = [];
      if (type) parts.push(type);
      if (pd) parts.push(`PD ${pd}`);
      rows.push(`Specs: ${parts.join(" · ")}`);
    }
    for (const [side, label] of [
      ["right", "RE"],
      ["left", "LE"],
    ] as const) {
      const eyeRaw = specs[side];
      if (!eyeRaw || typeof eyeRaw !== "object" || Array.isArray(eyeRaw)) continue;
      const values = eyeFieldValues(eyeRaw as Record<string, unknown>);
      if (values.every((value) => !value)) continue;
      rows.push(`${label} ${values.join(" / ")}`);
    }
  }

  if (source.ot && typeof source.ot === "object" && !Array.isArray(source.ot)) {
    const ot = source.ot as Record<string, unknown>;
    const eye = String(ot.eye ?? "").trim();
    const procedure = String(ot.procedure ?? "").trim();
    if (eye || procedure) {
      rows.push(`OT: ${[eye, procedure].filter(Boolean).join(" · ")}`);
    }
    if (isPresent(ot.notes)) {
      rows.push(`Notes: ${String(ot.notes)}`);
    }
  }

  for (const [key, value] of Object.entries(source)) {
    if (HANDLED_KEYS.has(key)) continue;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      if (typeof value === "string" && !value.trim()) continue;
      rows.push(`${key}: ${String(value)}`);
    }
  }

  return rows;
}
