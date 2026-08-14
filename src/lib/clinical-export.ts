import {
  buildCsvDocument,
  encodeCsvCell,
  encodeCsvNumber,
  encodeCsvPhone,
  formatIstTimestamp,
  slugForFilename,
} from "@/lib/clinical-csv";
import { normalizeDiagnoses } from "@/lib/clinical-diagnoses";

export type ExportRecordRow = {
  reg_no: number;
  patient_name: string;
  age: number | null;
  gender: string | null;
  phone: string | null;
  address: string | null;
  camp_name: string;
  transcription_at: string | null;
  data: Record<string, unknown> | null;
  medicine_outcome: string | null;
  specs_outcome: string | null;
  ot_outcome: string | null;
  unavailable_medicines: string[] | null;
};

export type ExportAuditRow = {
  reg_no: number;
  entity: string;
  event: string;
  from_outcome: string | null;
  to_outcome: string | null;
  slip_reference?: string | null;
  reason: string | null;
  actor_name: string | null;
  created_at: string;
};

function eyeField(
  data: Record<string, unknown> | null,
  side: "right" | "left",
  field: string,
): unknown {
  const specs = data?.specs;
  if (!specs || typeof specs !== "object" || Array.isArray(specs)) return "";
  const eye = (specs as Record<string, unknown>)[side];
  if (!eye || typeof eye !== "object" || Array.isArray(eye)) return "";
  return (eye as Record<string, unknown>)[field] ?? "";
}

function textField(value: unknown): string {
  if (value == null) return "";
  return String(value);
}

function yesBlank(flag: boolean): string {
  return flag ? "yes" : "";
}

export function buildCampRecordsCsv(
  campName: string,
  diagnosisOptions: string[],
  rows: ExportRecordRow[],
  retiredDiagnosisOptions: string[] = [],
): string {
  const retired = new Set(retiredDiagnosisOptions);
  const diagnosisHeaders = diagnosisOptions.map((option) =>
    retired.has(option)
      ? `diagnosis: ${option} (retired)`
      : `diagnosis: ${option}`,
  );
  const headers = [
    "registration_number",
    "patient_name",
    "age",
    "gender",
    "household_phone",
    "address",
    "camp_name",
    "transcription_at",
    ...diagnosisHeaders,
    "diagnosis_other",
    "blood_sugar",
    "blood_pressure",
    "remarks",
    "medicines",
    "unavailable_medicines",
    "spectacle_type",
    "right_sphere",
    "right_cylinder",
    "right_axis",
    "right_near",
    "right_vision",
    "left_sphere",
    "left_cylinder",
    "left_axis",
    "left_near",
    "left_vision",
    "pd",
    "ot_eye",
    "ot_procedure",
    "ot_notes",
    "medicine_outcome",
    "specs_outcome",
    "ot_outcome",
  ];

  const body = rows.map((row) => {
    const data = (row.data ?? null) as Record<string, unknown> | null;
    const templateOnly = diagnosisOptions.filter((option) => !retired.has(option));
    const diagnoses = normalizeDiagnoses(data?.diagnoses, templateOnly);
    const selected = new Set(diagnoses.options);
    const specs =
      data?.specs && typeof data.specs === "object" && !Array.isArray(data.specs)
        ? (data.specs as Record<string, unknown>)
        : null;
    const ot =
      data?.ot && typeof data.ot === "object" && !Array.isArray(data.ot)
        ? (data.ot as Record<string, unknown>)
        : null;
    const unavailable = Array.isArray(row.unavailable_medicines)
      ? row.unavailable_medicines.join("; ")
      : "";

    return [
      encodeCsvNumber(row.reg_no),
      encodeCsvCell(textField(row.patient_name)),
      encodeCsvNumber(row.age),
      encodeCsvCell(textField(row.gender)),
      encodeCsvPhone(row.phone),
      encodeCsvCell(textField(row.address)),
      encodeCsvCell(textField(row.camp_name || campName)),
      encodeCsvCell(formatIstTimestamp(row.transcription_at)),
      ...diagnosisOptions.map((option) =>
        encodeCsvCell(yesBlank(selected.has(option))),
      ),
      encodeCsvCell(diagnoses.other ?? ""),
      encodeCsvNumber(data?.bloodSugar ?? ""),
      encodeCsvCell(textField(data?.bloodPressure ?? "")),
      encodeCsvCell(textField(data?.remarks ?? "")),
      encodeCsvCell(textField(data?.medicines ?? "")),
      encodeCsvCell(unavailable),
      encodeCsvCell(textField(specs?.type ?? "")),
      encodeCsvNumber(eyeField(data, "right", "sphere")),
      encodeCsvNumber(eyeField(data, "right", "cylinder")),
      encodeCsvNumber(eyeField(data, "right", "axis")),
      encodeCsvNumber(eyeField(data, "right", "near")),
      encodeCsvCell(textField(eyeField(data, "right", "vision"))),
      encodeCsvNumber(eyeField(data, "left", "sphere")),
      encodeCsvNumber(eyeField(data, "left", "cylinder")),
      encodeCsvNumber(eyeField(data, "left", "axis")),
      encodeCsvNumber(eyeField(data, "left", "near")),
      encodeCsvCell(textField(eyeField(data, "left", "vision"))),
      encodeCsvNumber(specs?.pd ?? ""),
      encodeCsvCell(textField(ot?.eye ?? "")),
      encodeCsvCell(textField(ot?.procedure ?? "")),
      encodeCsvCell(textField(ot?.notes ?? "")),
      encodeCsvCell(textField(row.medicine_outcome ?? "")),
      encodeCsvCell(textField(row.specs_outcome ?? "")),
      encodeCsvCell(textField(row.ot_outcome ?? "")),
    ];
  });

  return buildCsvDocument([headers.map(encodeCsvCell), ...body]);
}

export function buildClinicalAuditCsv(
  _campName: string,
  rows: ExportAuditRow[],
): string {
  const headers = [
    "registration_number",
    "entity",
    "event",
    "from_outcome",
    "to_outcome",
    "slip_reference",
    "reason",
    "actor",
    "timestamp",
  ];
  const body = rows.map((row) => [
    encodeCsvNumber(row.reg_no),
    encodeCsvCell(textField(row.entity)),
    encodeCsvCell(textField(row.event)),
    encodeCsvCell(textField(row.from_outcome ?? "")),
    encodeCsvCell(textField(row.to_outcome ?? "")),
    encodeCsvCell(textField(row.slip_reference ?? "")),
    encodeCsvCell(textField(row.reason ?? "")),
    encodeCsvCell(textField(row.actor_name ?? "")),
    encodeCsvCell(formatIstTimestamp(row.created_at)),
  ]);
  return buildCsvDocument([headers.map(encodeCsvCell), ...body]);
}

export function formatIstDate(when: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(when);
}

export function exportFilename(
  kind: "records" | "audit",
  campName: string,
  when = new Date(),
): string {
  const date = formatIstDate(when);
  const slug = slugForFilename(campName);
  return kind === "records"
    ? `camp-records-${slug}-${date}.csv`
    : `clinical-audit-${slug}-${date}.csv`;
}
