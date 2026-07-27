"use client";

import { useEffect, useRef } from "react";
import { QrCode } from "@/components/qr-code";
import { formatCampDay } from "@/lib/format-camp-day";

export type PrescriptionPatient = {
  id: string;
  reg_no: number;
  full_name: string;
  age?: number | null;
  gender?: string | null;
};

export type PrescriptionCamp = {
  name: string;
  venue: string | null;
  camp_date: string | null;
};

export type PrescriptionClinicalData = {
  diagnosis?: string | null;
  examination?: string | null;
  medicines?: string | null;
  advice?: string | null;
};

export type PrescriptionAmendmentPrint = {
  id: string;
  author_name?: string | null;
  content: string;
  created_at: string;
};

export type PrescriptionPrintSheetProps = {
  patient: PrescriptionPatient;
  camp: PrescriptionCamp | null;
  campDayDate: string | null;
  qrValue: string;
  clinical?: PrescriptionClinicalData | null;
  amendments?: PrescriptionAmendmentPrint[] | null;
  deskHref?: string;
  deskLabel?: string;
  autoPrint?: boolean;
};

function formatGender(gender?: string | null): string {
  if (!gender) return "—";
  const upper = gender.trim().toUpperCase();
  if (upper === "M" || upper === "MALE") return "Male (M)";
  if (upper === "F" || upper === "FEMALE") return "Female (F)";
  if (upper === "O" || upper === "OTHER") return "Other (O)";
  return gender;
}

export function PrescriptionPrintSheet({
  patient,
  camp,
  campDayDate,
  qrValue,
  clinical,
  amendments,
  deskHref = "/doctor",
  deskLabel = "Doctor dashboard",
  autoPrint = false,
}: PrescriptionPrintSheetProps) {
  const autoStarted = useRef(false);

  useEffect(() => {
    if (!autoPrint || autoStarted.current) return;
    autoStarted.current = true;
    const timer = setTimeout(() => {
      window.print();
    }, 300);
    return () => clearTimeout(timer);
  }, [autoPrint]);

  const selectedDay = campDayDate || camp?.camp_date;
  const formattedDate = selectedDay ? formatCampDay(selectedDay) : "—";
  const venueText = camp?.venue || camp?.name || "—";
  const ageText = patient.age != null ? `${patient.age} yrs` : "—";
  const genderText = formatGender(patient.gender);

  const sections = [
    { key: "diagnosis", label: "Diagnosis (Nidan)", val: clinical?.diagnosis },
    { key: "examination", label: "Examination (Jaanch)", val: clinical?.examination },
    { key: "medicines", label: "Medicines (Dawaai)", val: clinical?.medicines },
    { key: "advice", label: "Advice / Follow-up (Salah)", val: clinical?.advice },
  ] as const;

  return (
    <div className="mx-auto max-w-[210mm] px-4 py-6">
      {/* Top action bar (hidden during print) */}
      <div className="no-print mb-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card p-4 shadow-sm">
        <div>
          <h1 className="text-lg font-bold text-foreground">A4 Prescription Print</h1>
          <p className="text-xs text-muted">
            Patient #{patient.reg_no} · {patient.full_name}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {deskHref && (
            <a
              href={deskHref}
              className="inline-flex items-center justify-center rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-accent transition-colors"
            >
              &larr; {deskLabel}
            </a>
          )}
          <button
            type="button"
            onClick={() => window.print()}
            data-testid="print-prescription-button"
            className="inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors shadow-sm"
          >
            Print Prescription (A4)
          </button>
        </div>
      </div>

      {/* A4 Printable Prescription Sheet */}
      <article
        className="prescription-a4 print-sheet print-preview mx-auto min-h-[297mm] w-full max-w-[210mm] bg-white p-8 text-[#0f172a] shadow-md border border-slate-200 flex flex-col justify-between"
        data-print-format="a4-prescription"
        data-patient-id={patient.id}
        aria-label="A4 Prescription Print Sheet"
      >
        <div>
          {/* Header Block */}
          <header className="border-b-2 border-slate-800 pb-4 mb-6" data-testid="prescription-header">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-widest text-emerald-800">
                  SIKAR NAGARIK PARISHAD (KOLKATA)
                </p>
                <h2 className="text-2xl font-extrabold tracking-tight text-slate-900 mt-0.5">
                  FREE EYE CAMP PRESCRIPTION
                </h2>
                <p className="text-xs text-slate-600 mt-1">
                  Medical Consultation & Treatment Record
                </p>
              </div>

              {/* Staff-scan Patient QR code */}
              <div
                className="flex flex-col items-center gap-1 shrink-0"
                data-testid="patient-qr-code"
                data-qr-value={qrValue}
              >
                <div className="rounded border border-slate-900 bg-white p-1">
                  <QrCode value={qrValue} size={84} level="M" fgColor="#0f172a" />
                </div>
                <span className="text-[9px] font-bold uppercase tracking-wider text-slate-700">
                  Staff Scan
                </span>
              </div>
            </div>

            {/* Patient Header Meta Grid */}
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3 rounded-lg border border-slate-200 bg-slate-50/70 p-3 text-xs">
              <div>
                <span className="block text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  Reg No.
                </span>
                <span className="text-base font-extrabold text-slate-900" data-testid="patient-reg-no">
                  #{patient.reg_no}
                </span>
              </div>

              <div>
                <span className="block text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  Patient Name
                </span>
                <span className="font-bold text-slate-900" data-testid="patient-name">
                  {patient.full_name}
                </span>
              </div>

              <div>
                <span className="block text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  Age / Gender
                </span>
                <span className="font-semibold text-slate-900" data-testid="patient-age-gender">
                  {ageText} · {genderText}
                </span>
              </div>

              <div>
                <span className="block text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  Camp Date & Venue
                </span>
                <span className="font-semibold text-slate-900 block truncate" data-testid="patient-camp-meta">
                  {formattedDate} ({venueText})
                </span>
              </div>
            </div>
          </header>

          {/* Clinical Body */}
          <main className="space-y-6" data-testid="prescription-clinical-body">
            {sections.map(({ key, label, val }) => {
              const hasContent = typeof val === "string" && val.trim().length > 0;
              return (
                <section
                  key={key}
                  className="rounded-lg border border-slate-200 bg-white p-4"
                  data-testid={`section-${key}`}
                >
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800 border-b border-slate-200 pb-1.5 mb-2.5">
                    {label}
                  </h3>
                  {hasContent ? (
                    <div
                      className="whitespace-pre-wrap text-sm text-slate-900 font-medium leading-relaxed"
                      data-testid={`clinical-${key}`}
                    >
                      {val.trim()}
                    </div>
                  ) : (
                    /* Empty section: ruled blank lines for handwriting */
                    <div
                      className="ruled-lines space-y-7 py-1"
                      data-testid="ruled-lines"
                      data-testid-section={`ruled-lines-${key}`}
                      data-section={key}
                    >
                      <div className="border-b border-slate-300 h-7" />
                      <div className="border-b border-slate-300 h-7" />
                      <div className="border-b border-slate-300 h-7" />
                      <div className="border-b border-slate-300 h-7" />
                    </div>
                  )}
                </section>
              );
            })}

            {amendments && amendments.length > 0 ? (
              <section className="rounded-lg border border-amber-300 bg-amber-50/50 p-4" data-testid="prescription-amendments-print">
                <h3 className="text-xs font-bold uppercase tracking-wider text-amber-900 border-b border-amber-200 pb-1.5 mb-3">
                  Prescription Amendments ({amendments.length})
                </h3>
                <div className="space-y-3">
                  {amendments.map((a) => (
                    <div key={a.id} className="rounded border border-amber-200 bg-white p-3 text-xs" data-testid="amendment-print-item">
                      <div className="flex items-center justify-between text-[11px] font-semibold text-amber-950 mb-1">
                        <span>Dr. {a.author_name || "Doctor"}</span>
                        <time className="text-slate-500">{new Date(a.created_at).toLocaleString()}</time>
                      </div>
                      <p className="whitespace-pre-wrap font-medium text-slate-900 text-sm">{a.content}</p>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </main>
        </div>

        {/* Footer / Doctor Signature Block */}
        <footer className="mt-8 border-t border-slate-300 pt-4 flex items-end justify-between text-xs text-slate-600">
          <div>
            <p className="font-semibold text-slate-700">Sikar Nagarik Parishad Free Eye Camp</p>
            <p className="text-[11px] text-slate-500 mt-0.5">Please bring this prescription for follow-up visits.</p>
          </div>
          <div className="text-right">
            <div className="h-12 border-b border-slate-400 w-44 mb-1" />
            <p className="font-bold text-slate-900">Doctor's Signature & Stamp</p>
          </div>
        </footer>
      </article>
    </div>
  );
}
