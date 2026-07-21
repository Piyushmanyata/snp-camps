import { QrCode } from "@/components/qr-code";

type Props = {
  patient: {
    id: string;
    reg_no: number;
    full_name: string;
    gender: string | null;
    age: number | null;
    address: string | null;
    phone: string | null;
    email: string | null;
  };
  camp: {
    name: string;
    venue: string | null;
    camp_date: string | null;
  } | null;
  origin: string;
  today: string;
  /** Staff-scan QR on paper (enter URL preferred). */
  qrValue?: string;
};

/** Dense one-page A4 prescription matching SNP eye-clinic form. */
export function PrintSheet({ patient, camp, origin, today, qrValue }: Props) {
  const qr =
    qrValue || `${origin.replace(/\/$/, "")}/patient/enter/${patient.id}`;
  const venue = camp?.venue || camp?.name || "SIKAR BHAWAN";
  const genderMark =
    patient.gender === "M" ? "M" : patient.gender === "F" ? "F" : "M / F";

  return (
    <article className="print-sheet print-preview mx-auto w-full max-w-[210mm] border border-[#1a3a8a] bg-white text-[#1a3a8a]">
      <header className="border-b border-[#1a3a8a] px-3 pb-1.5 pt-2 text-center">
        <p className="text-[13px] font-extrabold leading-tight tracking-wide sm:text-[15px]">
          SIKAR NAGARIK PARISHAD (KOLKATA)
        </p>
        <p className="text-[10px] font-semibold leading-tight sm:text-[11px]">
          SIKAR ZILLA WELFARE TRUST
        </p>
        <p className="mt-0.5 text-[8px] leading-snug sm:text-[9px]">
          &apos;SIKAR BHAWAN&apos; 1A, ASHUTOSH DEY LANE, KOLKATA-6 · Ph: 033 4006
          4713 · WhatsApp: 86971 90268
        </p>
        <p className="mt-1 text-[8.5px] font-bold uppercase leading-tight tracking-wide sm:text-[9.5px]">
          Free eye screening · spectacles · medicines · cataract (IOL)
        </p>
      </header>

      <div className="px-3 py-2">
        <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0 text-[10px] sm:text-[11px]">
          <div className="min-w-0 space-y-1">
            <Line label="Venue" value={venue} />
            <Line label="Name" value={patient.full_name} strong />
            <Line label="Address" value={patient.address || ""} />
            <Line label="E-mail" value={patient.email || ""} />
            <Line label="Contact No." value={patient.phone || ""} />
          </div>

          <div className="flex w-[7.8rem] flex-col items-end gap-1 sm:w-36">
            <div className="w-full rounded border border-[#1a3a8a] px-1.5 py-1 text-right">
              <p className="text-[8px] font-semibold uppercase leading-none">
                Reg. No.
              </p>
              <p className="text-lg font-extrabold leading-tight tabular-nums sm:text-xl">
                {patient.reg_no}
              </p>
            </div>
            <p className="w-full text-right text-[9px]">
              <span className="font-semibold">Date</span> {today}
            </p>
            <p className="w-full text-right text-[9px]">
              <span className="font-semibold">Age</span>{" "}
              {patient.age ?? "——"}{" "}
              <span className="ml-1 font-semibold">{genderMark}</span>
            </p>
            <div className="mt-0.5 flex flex-col items-end gap-0.5">
              <div className="rounded border border-[#1a3a8a] bg-white p-1">
                <QrCode
                  value={qr}
                  size={112}
                  level="H"
                  includeMargin
                  fgColor="#1a3a8a"
                />
              </div>
              <p className="w-full text-right text-[7px] font-semibold uppercase leading-none tracking-wide opacity-80">
                Staff scan
              </p>
            </div>
          </div>
        </div>

        <div className="mt-2 border-t border-dotted border-[#1a3a8a] pt-1.5">
          <p className="mb-1 text-[10px] font-bold">Diagnosis:</p>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[9px] sm:text-[10px]">
            <Check label="RE – CATARACT" />
            <Check label="LE – CATARACT" />
            <Check label="REFRACTION" />
            <Check label="MEDICINE" />
          </div>
        </div>

        <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[9.5px] sm:text-[10px]">
          <div className="space-y-1">
            <Line label="Blood Sugar (R)" value="" />
            <Line label="BP" value="" />
            <Line label="Remarks" value="" />
          </div>
          <div className="space-y-1">
            <Line label="Medicines" value="" />
            <div className="min-h-[1.6rem] border-b border-dotted border-[#1a3a8a]" />
            <div className="min-h-[1.6rem] border-b border-dotted border-[#1a3a8a]" />
          </div>
        </div>

        <div className="mt-1.5 text-[9.5px] sm:text-[10px]">
          <Line label="Operation will be done at" value="" />
        </div>

        <div className="mt-2">
          <p className="mb-0.5 text-center text-[9px] font-extrabold uppercase tracking-wider">
            — Prescription for glasses —
          </p>
          <table className="w-full border-collapse border border-[#1a3a8a] text-center text-[8px] sm:text-[9px]">
            <thead>
              <tr>
                <th className="w-[14%] border border-[#1a3a8a] p-0.5" rowSpan={2} />
                <th className="border border-[#1a3a8a] p-0.5 font-bold" colSpan={4}>
                  RE
                </th>
                <th className="border border-[#1a3a8a] p-0.5 font-bold" colSpan={4}>
                  LE
                </th>
              </tr>
              <tr>
                {["Dsph", "Dcyl", "Axis", "Vision", "Dsph", "Dcyl", "Axis", "Vision"].map(
                  (h, i) => (
                    <th
                      key={`${h}-${i}`}
                      className="border border-[#1a3a8a] px-0.5 py-0.5 font-semibold"
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {["Distance", "Near"].map((row) => (
                <tr key={row}>
                  <td className="border border-[#1a3a8a] px-1 py-2 text-left font-semibold">
                    {row}
                  </td>
                  {Array.from({ length: 8 }).map((_, i) => (
                    <td key={i} className="border border-[#1a3a8a] py-2">
                      &nbsp;
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-[9px]">
            Inter Pupillary distance ……………… mm
          </p>
        </div>

        <footer className="mt-2 flex items-end justify-between gap-3 border-t border-[#1a3a8a] pt-1.5 text-[9px]">
          <div>
            <p className="font-extrabold">Sponsorer:</p>
            <p className="font-semibold leading-tight">RUPA FOUNDATION, KOLKATA</p>
            <p className="mt-0.5 max-w-[12rem] text-[7.5px] leading-snug opacity-80">
              SNP &amp; Sikar Zilla Welfare Trust — free eye screening &amp; IOL
              arrangement
            </p>
          </div>
          <div className="text-right">
            <p className="leading-tight">Signature of</p>
            <p className="leading-tight">Optometrist / Eye Surgeon</p>
            <p className="mt-3 tracking-widest">________________</p>
          </div>
        </footer>
      </div>
    </article>
  );
}

function Line({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <p className="flex min-h-[1.15rem] items-end gap-1 border-b border-dotted border-[#1a3a8a] pb-px">
      <span className="shrink-0 font-semibold">{label}:</span>
      <span
        className={`min-w-0 flex-1 text-black ${strong ? "font-bold" : ""}`}
      >
        {value || "\u00a0"}
      </span>
    </p>
  );
}

function Check({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-block h-2.5 w-2.5 shrink-0 border border-[#1a3a8a]" />
      {label}
    </span>
  );
}
