import { QrCode } from "@/components/qr-code";
import { formatCampDay } from "@/lib/format-camp-day";
import {
  DEFAULT_PRESCRIPTION_TEMPLATE,
  type PrescriptionTemplate,
} from "@/lib/prescription-template";

/**
 * The printed prescription. This is the ONLY thing the desk prints on a camp
 * day, and printing it is what puts a patient in the queue.
 *
 * The identity block is pre-filled from the patient record; every clinical
 * field is left blank for the optometrist to write by hand. The Patient QR
 * sits beside the registration number so a volunteer can scan the sheet to
 * mark the patient seen.
 */

export type PrescriptionSheetPatient = {
  id: string;
  reg_no: number;
  full_name: string;
  age: number | null;
  gender: string | null;
  address: string | null;
  phone: string | null;
};

export type PrescriptionSheetProps = {
  patient: PrescriptionSheetPatient;
  camp: { name: string; venue: string | null } | null;
  campDayDate: string | null;
  qrValue: string;
  template?: PrescriptionTemplate;
};

/** A dotted write-on line with an optional pre-filled value. */
function FilledLine({
  label,
  value,
  className = "",
}: {
  label: string;
  value?: string | null;
  className?: string;
}) {
  return (
    <div className={`flex items-baseline gap-2 ${className}`}>
      <span className="shrink-0 text-[10pt] leading-tight">{label}</span>
      <span className="min-w-0 flex-1 border-b border-dotted border-current pb-[1px] text-[10pt] font-semibold leading-tight">
        {value || " "}
      </span>
    </div>
  );
}

function GenderBox({ gender }: { gender: string | null }) {
  const male = gender === "M";
  const female = gender === "F";
  const box = "inline-flex h-[14px] w-[14px] items-center justify-center border border-current text-[8pt] font-bold leading-none";
  return (
    <span className="inline-flex items-center gap-1">
      <span className={box} aria-label={male ? "Male, selected" : "Male"}>
        {male ? "M" : "M"}
      </span>
      <span className="text-[9pt]">/</span>
      <span className={box} aria-label={female ? "Female, selected" : "Female"}>
        {female ? "F" : "F"}
      </span>
      {male || female ? (
        <span className="ml-1 text-[9pt] font-bold">
          {male ? "← M" : "← F"}
        </span>
      ) : null}
    </span>
  );
}

/** Empty cell of the refraction table — the optometrist writes in these. */
const cell = "border border-current px-1 py-[6px]";

export function PrescriptionSheet({
  patient,
  camp,
  campDayDate,
  qrValue,
  template = DEFAULT_PRESCRIPTION_TEMPLATE,
}: PrescriptionSheetProps) {
  const venue = camp?.venue || camp?.name || "";
  const day = campDayDate ? formatCampDay(campDayDate) : "";

  return (
    <article
      className="prescription-sheet print-sheet print-preview mx-auto w-full max-w-[210mm] bg-white p-[10mm] text-[#0f2f6b]"
      data-testid="prescription-sheet"
      data-print-format="prescription-a4"
      aria-label={`Prescription for registration number ${patient.reg_no}`}
    >
      {/* Letterhead — one image so no Indic font is needed on the printer. */}
      {template.letterheadUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- print asset, no optimisation pipeline
        <img
          src={template.letterheadUrl}
          alt=""
          className="mb-2 block w-full"
          aria-hidden="true"
        />
      ) : null}

      {/* Identity: dotted lines left, boxed registration block + QR right. */}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-[7px] pt-1">
          <FilledLine label="Venue" value={venue} />
          <FilledLine label="Name" value={patient.full_name} />
          <FilledLine label="Address" value={patient.address} />
        </div>

        <div className="flex shrink-0 items-start gap-2">
          <div className="w-[62mm] space-y-[6px] border border-current p-2">
            <div className="flex items-baseline gap-2">
              <span className="shrink-0 text-[10pt]">Reg. No.</span>
              <span className="min-w-0 flex-1 border-b border-dotted border-current text-[15pt] font-black leading-none tabular">
                {patient.reg_no}
              </span>
            </div>
            <FilledLine label="Date" value={day} />
            <div className="flex items-baseline gap-2">
              <span className="shrink-0 text-[10pt]">Age</span>
              <span className="min-w-0 flex-1 border-b border-dotted border-current text-[10pt] font-semibold">
                {patient.age != null ? patient.age : " "}
              </span>
              <GenderBox gender={patient.gender} />
            </div>
            <FilledLine label="Contact No." value={patient.phone} />
          </div>

          {/* Patient QR — staff scan to queue and to mark seen. */}
          <div className="text-center">
            <div className="border border-current p-[3px]">
              <QrCode value={qrValue} size={92} />
            </div>
            <p className="mt-[2px] w-[92px] text-[6pt] font-bold uppercase leading-tight">
              Patient QR · staff scan
            </p>
          </div>
        </div>
      </div>

      {/* Diagnosis tick boxes */}
      <div className="mt-3">
        <p className="text-[10pt] font-bold">Diagnosis :</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-5 gap-y-1 border border-current px-2 py-[6px]">
          {template.diagnosisOptions.map((option) => (
            <span key={option} className="inline-flex items-center gap-[6px]">
              <span
                className="inline-block h-[13px] w-[13px] border border-current"
                aria-hidden="true"
              />
              <span className="text-[9.5pt] font-semibold">{option}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Vitals + write-in sections */}
      <div className="mt-2 space-y-[6px]">
        {template.vitalsFields.map((field) => (
          <FilledLine key={field} label={`${field} :`} />
        ))}
        {template.sections.map((section) => (
          <div key={section.key}>
            <p className="text-[10pt] font-bold">{section.label} :</p>
            <div
              className="mt-[2px] border-b border-dotted border-current"
              style={{ height: `${section.heightMm}mm` }}
            />
          </div>
        ))}
      </div>

      {/* Operation venue */}
      {template.operationLabel ? (
        <div className="mt-2 border border-current px-2 py-[7px]">
          <span className="text-[11pt] font-bold">
            {template.operationLabel}
          </span>
        </div>
      ) : null}

      {/* Refraction table */}
      {template.showGlassesTable ? (
        <div className="mt-2 border border-current">
          <p className="border-b border-current py-[3px] text-center text-[10pt] font-bold italic">
            {template.glassesTableTitle}
          </p>
          <table className="w-full border-collapse text-center text-[8.5pt]">
            <thead>
              <tr>
                <th className={`${cell} w-[16mm]`} />
                <th className={cell} colSpan={4}>
                  RE
                </th>
                <th className={cell} colSpan={4}>
                  LE
                </th>
              </tr>
              <tr>
                <th className={cell} />
                {["Dsph", "Dcyl", "Axis", "Vision", "Dsph", "Dcyl", "Axis", "Vision"].map(
                  (head, index) => (
                    <th key={`${head}-${index}`} className={cell}>
                      {head}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th className={`${cell} text-left font-semibold`}>Distance</th>
                {Array.from({ length: 8 }, (_, index) => (
                  <td key={index} className={`${cell} h-[9mm]`} />
                ))}
              </tr>
              <tr>
                <th className={`${cell} text-left font-semibold`}>Near</th>
                <td className={`${cell} h-[9mm]`} colSpan={2}>
                  Add.
                </td>
                <td className={cell} colSpan={2}>
                  Dsph
                </td>
                <td className={cell} colSpan={2}>
                  Add.
                </td>
                <td className={cell} colSpan={2}>
                  Dsph
                </td>
              </tr>
            </tbody>
          </table>
          <p className="flex items-baseline gap-2 border-t border-current px-2 py-[6px] text-[9.5pt]">
            <span className="shrink-0">Inter Pupillary distance</span>
            <span className="min-w-0 flex-1 border-b border-dotted border-current" />
            <span className="shrink-0">mm</span>
          </p>
        </div>
      ) : null}

      {/* Footer + sponsor + signature */}
      {template.footerNote ? (
        <p className="mt-2 border border-current px-2 py-[5px] text-[7.5pt] leading-snug">
          {template.footerNote}
        </p>
      ) : null}

      <div className="mt-2 flex items-end justify-between gap-4">
        <div>
          {template.sponsorLabel ? (
            <p className="text-[12pt] font-bold">{template.sponsorLabel}</p>
          ) : null}
          {template.sponsorLogoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- print asset
            <img
              src={template.sponsorLogoUrl}
              alt=""
              className="mt-1 h-[16mm] w-auto"
              aria-hidden="true"
            />
          ) : null}
        </div>
        <p className="pb-1 text-right text-[9pt] leading-tight">
          {template.signatureLabel}
        </p>
      </div>
    </article>
  );
}
