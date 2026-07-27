import { QrCode } from "@/components/qr-code";
import { formatCampDay } from "@/lib/format-camp-day";

/**
 * Blank Prescription Sheet printed at registration when a camp is in
 * paper-fallback mode (#108). Pre-filled identity + Patient QR; ruled space
 * for the doctor to write by hand. Not the completed prescription print page.
 */
export type RegistrationPrescriptionSheetProps = {
  patient: {
    id: string;
    reg_no: number;
    full_name: string;
    age: number | null;
    gender: string | null;
  };
  camp: { name: string; venue: string | null } | null;
  campDayDate: string | null;
  qrValue: string;
};

export function RegistrationPrescriptionSheet({
  patient,
  camp,
  campDayDate,
  qrValue,
}: RegistrationPrescriptionSheetProps) {
  const day = campDayDate
    ? formatCampDay(campDayDate)
    : camp
      ? "—"
      : "Not set";
  const venue = camp?.venue || camp?.name || "—";
  const genderLabel =
    patient.gender === "M"
      ? "Male"
      : patient.gender === "F"
        ? "Female"
        : patient.gender === "O"
          ? "Other"
          : patient.gender || "—";

  return (
    <article
      className="print-sheet print-preview mx-auto max-w-[210mm] bg-white p-6 text-[#0f172a]"
      data-testid="registration-prescription-sheet"
      data-print-format="prescription-sheet"
    >
      <header className="flex items-start justify-between gap-4 border-b-2 border-slate-900 pb-3">
        <div className="min-w-0">
          <p className="text-[0.6875rem] font-bold uppercase tracking-wide text-slate-600">
            Prescription sheet · write by hand
          </p>
          <p className="mt-1 text-4xl font-black tabular tracking-tight">
            #{patient.reg_no}
          </p>
          <p className="mt-1 text-xl font-bold leading-snug">
            {patient.full_name}
          </p>
          <p className="mt-1 text-sm text-slate-700">
            {[
              patient.age != null ? `${patient.age}y` : null,
              genderLabel,
              day,
              venue,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="shrink-0 text-center">
          <div className="inline-block rounded border border-slate-300 p-1">
            <QrCode value={qrValue} size={112} />
          </div>
          <p className="mt-1 max-w-[7.5rem] text-[0.625rem] font-semibold leading-tight text-slate-600">
            Patient QR · staff scan for check-in
          </p>
        </div>
      </header>

      <RuledBlock title="Diagnosis" lines={5} />
      <RuledBlock title="Medicines" lines={7} />
      <RuledBlock title="Advice" lines={5} />

      <footer className="mt-6 flex justify-between border-t border-slate-300 pt-3 text-xs text-slate-600">
        <span>Doctor signature: ________________________</span>
        <span>Date: ____________</span>
      </footer>
    </article>
  );
}

function RuledBlock({ title, lines }: { title: string; lines: number }) {
  return (
    <section className="mt-5">
      <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-800">
        {title}
      </h2>
      <div className="space-y-0">
        {Array.from({ length: lines }, (_, i) => (
          <div
            key={i}
            className="h-8 border-b border-slate-400"
            aria-hidden="true"
          />
        ))}
      </div>
    </section>
  );
}
