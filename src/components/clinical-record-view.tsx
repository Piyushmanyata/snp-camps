import { formatClinicalRecordRows } from "@/lib/clinical-record-format";

export function ClinicalRecordView({ data }: { data: unknown }) {
  const rows = formatClinicalRecordRows(data);
  if (!rows.length) return null;
  return (
    <div className="mt-2 space-y-1 text-sm text-foreground">
      {rows.map((row, index) => (
        <p key={`${index}-${row}`}>{row}</p>
      ))}
    </div>
  );
}
