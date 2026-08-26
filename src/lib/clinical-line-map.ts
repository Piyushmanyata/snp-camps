export const CLINICAL_LINES = [
  "fixed_power",
  "medicine",
  "specs_to_make",
  "ot",
] as const;

export type ClinicalLine = (typeof CLINICAL_LINES)[number];

export const CLINICAL_LINE_LABELS: Record<ClinicalLine, string> = {
  fixed_power: "Ready spectacles",
  medicine: "Medicines",
  specs_to_make: "Custom spectacles",
  ot: "Surgery (OT)",
};

export function lineKind(line: ClinicalLine): "specs" | "medicine" | "ot" {
  if (line === "medicine") return "medicine";
  if (line === "ot") return "ot";
  return "specs";
}

export function lineDecisions(
  line: ClinicalLine,
): readonly ("fulfilled" | "deferred" | "not_required" | "not_available")[] {
  if (line === "fixed_power") return ["fulfilled", "not_required"];
  if (line === "medicine") return ["fulfilled", "not_available", "not_required"];
  if (line === "specs_to_make") return ["deferred", "not_required"];
  return ["fulfilled", "deferred", "not_required"];
}

export function otherSpecsLine(line: ClinicalLine): ClinicalLine | null {
  if (line === "fixed_power") return "specs_to_make";
  if (line === "specs_to_make") return "fixed_power";
  return null;
}
