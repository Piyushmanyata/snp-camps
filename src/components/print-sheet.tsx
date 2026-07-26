import { QrCode } from "@/components/qr-code";
import { formatCampDay } from "@/lib/format-camp-day";
import type { DeskSlipFormat } from "@/lib/desk-slip-format";

export type DeskSlipPatient = {
  id: string;
  reg_no: number;
  full_name: string;
};

export type DeskSlipCamp = {
  name: string;
  venue: string | null;
  camp_date: string | null;
};

type SlipFields = {
  regNo: number;
  name: string;
  campDay: string;
  venue: string;
  /** Required compact staff-scan payload (e.g. snp:<uuid>). No long-URL fallback. */
  qrValue: string;
};

type Props = {
  format: DeskSlipFormat;
  patient: DeskSlipPatient;
  camp: DeskSlipCamp | null;
  campDayDate: string | null;
  /** Compact Patient QR value — required; omitting is a type error. */
  qrValue: string;
};

function slipFields(
  patient: DeskSlipPatient,
  camp: DeskSlipCamp | null,
  campDayDate: string | null,
  qrValue: string,
): SlipFields {
  const selectedDay = campDayDate || camp?.camp_date;
  return {
    regNo: patient.reg_no,
    name: patient.full_name,
    campDay: selectedDay ? formatCampDay(selectedDay) : "Not set",
    venue: camp?.venue || camp?.name || "—",
    qrValue,
  };
}

/**
 * Desk slip for camp printers.
 * A4 and thermal are separate layouts so one path can be deleted later.
 */
export function PrintSheet({
  format,
  patient,
  camp,
  campDayDate,
  qrValue,
}: Props) {
  const fields = slipFields(patient, camp, campDayDate, qrValue);
  if (format === "thermal58") {
    return <DeskSlipThermal fields={fields} />;
  }
  return <DeskSlipA4 fields={fields} />;
}

/** A4: 2×2 identical slips with cut lines (spares + easy cutting). */
function DeskSlipA4({ fields }: { fields: SlipFields }) {
  return (
    <div
      className="desk-slip-a4 print-sheet print-preview mx-auto w-full max-w-[210mm] bg-white text-[#0f172a]"
      data-print-format="a4"
      data-testid="desk-slip-a4"
    >
      <div className="desk-slip-a4-grid">
        {Array.from({ length: 4 }, (_, i) => (
          <article
            key={i}
            className="desk-slip-a4-cell"
            aria-label={`Desk slip copy ${i + 1}`}
          >
            <SlipBody fields={fields} variant="a4" />
          </article>
        ))}
      </div>
    </div>
  );
}

/** 58mm thermal roll — narrow stack, not a scaled A4. */
function DeskSlipThermal({ fields }: { fields: SlipFields }) {
  return (
    <article
      className="desk-slip-thermal print-sheet print-preview mx-auto bg-white text-[#0f172a]"
      data-print-format="thermal58"
      data-testid="desk-slip-thermal"
      aria-label="Desk slip thermal"
    >
      <SlipBody fields={fields} variant="thermal" />
    </article>
  );
}

function SlipBody({
  fields,
  variant,
}: {
  fields: SlipFields;
  variant: "a4" | "thermal";
}) {
  const isThermal = variant === "thermal";
  const qrSize = isThermal ? 96 : 88;

  return (
    <div
      className={
        isThermal
          ? "flex flex-col items-stretch gap-1.5 px-1.5 py-2"
          : "flex h-full flex-col justify-between gap-1 p-2"
      }
    >
      <p
        className={
          isThermal
            ? "text-center text-[9px] font-bold uppercase tracking-wide text-[#1a3a8a]"
            : "text-center text-[8px] font-bold uppercase tracking-wide text-[#1a3a8a]"
        }
      >
        SNP · Free eye camp
      </p>

      {/* Reg no — largest element; readable across a desk */}
      <div className="text-center">
        <p
          className={
            isThermal
              ? "text-[10px] font-semibold uppercase tracking-wide opacity-80"
              : "text-[9px] font-semibold uppercase tracking-wide opacity-80"
          }
        >
          Reg. No.
        </p>
        <p
          className={
            isThermal
              ? "text-[42px] font-extrabold leading-none tabular-nums tracking-tight"
              : "text-[36px] font-extrabold leading-none tabular-nums tracking-tight sm:text-[40px]"
          }
          data-testid="desk-slip-reg-no"
        >
          {fields.regNo}
        </p>
      </div>

      <div className={isThermal ? "space-y-0.5 text-center" : "space-y-0.5"}>
        <p
          className={
            isThermal
              ? "text-[15px] font-bold leading-tight"
              : "text-[13px] font-bold leading-tight sm:text-[14px]"
          }
          data-testid="desk-slip-name"
        >
          {fields.name}
        </p>
        <p
          className={
            isThermal
              ? "text-[11px] leading-snug"
              : "text-[10px] leading-snug sm:text-[11px]"
          }
          data-testid="desk-slip-camp-day"
        >
          <span className="font-semibold">Camp day</span> {fields.campDay}
        </p>
        <p
          className={
            isThermal
              ? "text-[11px] leading-snug"
              : "text-[10px] leading-snug sm:text-[11px]"
          }
          data-testid="desk-slip-venue"
        >
          <span className="font-semibold">Venue</span> {fields.venue}
        </p>
      </div>

      <div className="flex flex-col items-center gap-0.5">
        <div className="rounded border border-[#0f172a] bg-white p-0.5">
          <QrCode
            value={fields.qrValue}
            size={qrSize}
            level="M"
            includeMargin={false}
            fgColor="#0f172a"
          />
        </div>
        <p
          className={
            isThermal
              ? "text-[8px] font-semibold uppercase tracking-wide opacity-70"
              : "text-[7px] font-semibold uppercase tracking-wide opacity-70"
          }
        >
          Staff scan
        </p>
      </div>
    </div>
  );
}
