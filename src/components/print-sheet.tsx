import { QrCode } from "@/components/qr-code";
import { formatCampDay } from "@/lib/format-camp-day";
import type { DeskSlipFormat } from "@/lib/desk-slip-format";
import { A4_BATCH_MAX } from "@/lib/a4-batch-queue";

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

/** One filled A4/thermal cell. */
export type DeskSlipSlot = {
  patient: DeskSlipPatient;
  camp: DeskSlipCamp | null;
  campDayDate: string | null;
  /** Required compact staff-scan payload (e.g. snp:<uuid>). */
  qrValue: string;
  /** Optional; used by print actions for check-in messaging. */
  queueStatus?: "registered" | "waiting" | "seen";
};

type SlipFields = {
  regNo: number;
  name: string;
  campDay: string;
  venue: string;
  qrValue: string;
  patientId: string;
};

type Props = {
  format: DeskSlipFormat;
  /**
   * Distinct slips for this sheet. A4 shows up to 4; unused cells stay empty
   * (never duplicated). Thermal uses only the first slip.
   */
  slips: DeskSlipSlot[];
};

/** Documented max lengths for geometry tests (#64). */
export const DESK_SLIP_MAX_NAME_CHARS = 120;
/** Realistic long venue (camp ground + locality). */
export const DESK_SLIP_MAX_VENUE_CHARS = 80;

function slipFields(slot: DeskSlipSlot): SlipFields {
  const selectedDay = slot.campDayDate || slot.camp?.camp_date;
  return {
    regNo: slot.patient.reg_no,
    name: slot.patient.full_name,
    campDay: selectedDay ? formatCampDay(selectedDay) : "Not set",
    venue: slot.camp?.venue || slot.camp?.name || "—",
    qrValue: slot.qrValue,
    patientId: slot.patient.id,
  };
}

/**
 * Desk slip for camp printers.
 * A4: up to four **distinct** patients (empty cells for unused slots).
 * Thermal: single patient, content-safe height.
 */
export function PrintSheet({ format, slips }: Props) {
  if (format === "thermal58") {
    const first = slips[0];
    if (!first) {
      return (
        <div
          className="print-sheet print-preview mx-auto bg-white p-4 text-center text-sm text-[#64748b]"
          data-testid="desk-slip-empty"
        >
          No patient on this thermal slip.
        </div>
      );
    }
    return <DeskSlipThermal fields={slipFields(first)} />;
  }
  return <DeskSlipA4 slips={slips.slice(0, A4_BATCH_MAX)} />;
}

/** A4: 2×2 distinct slips with cut lines; empty cells when fewer than four. */
function DeskSlipA4({ slips }: { slips: DeskSlipSlot[] }) {
  const cells: Array<SlipFields | null> = Array.from(
    { length: A4_BATCH_MAX },
    (_, i) => (slips[i] ? slipFields(slips[i]!) : null),
  );

  return (
    <div
      className="desk-slip-a4 print-sheet print-preview mx-auto w-full max-w-[210mm] bg-white text-[#0f172a]"
      data-print-format="a4"
      data-testid="desk-slip-a4"
      data-slip-count={slips.length}
    >
      <div className="desk-slip-a4-grid" data-testid="desk-slip-a4-grid">
        {cells.map((fields, i) => (
          <article
            key={fields ? fields.patientId : `empty-${i}`}
            className={
              fields
                ? "desk-slip-a4-cell"
                : "desk-slip-a4-cell desk-slip-a4-cell--empty"
            }
            aria-label={
              fields
                ? `Desk slip for reg ${fields.regNo}`
                : `Empty slip slot ${i + 1}`
            }
            data-testid={fields ? "desk-slip-a4-cell" : "desk-slip-a4-cell-empty"}
            data-patient-id={fields?.patientId ?? ""}
            data-cell-index={i}
          >
            {fields ? (
              <SlipBody fields={fields} variant="a4" />
            ) : (
              <div
                className="flex h-full min-h-[4rem] items-center justify-center p-2 text-[10px] uppercase tracking-wide text-[#94a3b8]"
                aria-hidden
              >
                Empty
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}

/** 58mm thermal roll — narrow stack, content-safe height (no fixed clip). */
function DeskSlipThermal({ fields }: { fields: SlipFields }) {
  return (
    <article
      className="desk-slip-thermal print-sheet print-preview mx-auto bg-white text-[#0f172a]"
      data-print-format="thermal58"
      data-testid="desk-slip-thermal"
      data-patient-id={fields.patientId}
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
  // Keep QR large enough to scan; do not shrink below these sizes.
  const qrSize = isThermal ? 96 : 88;

  return (
    <div
      className={
        isThermal
          ? "flex flex-col items-stretch gap-1.5 px-1.5 py-2"
          : "flex h-full flex-col justify-between gap-1 overflow-visible p-2"
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
              ? "desk-slip-name text-[15px] font-bold leading-tight"
              : "desk-slip-name text-[13px] font-bold leading-tight sm:text-[14px]"
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
              ? "desk-slip-venue text-[11px] leading-snug"
              : "desk-slip-venue text-[10px] leading-snug sm:text-[11px]"
          }
          data-testid="desk-slip-venue"
        >
          <span className="font-semibold">Venue</span> {fields.venue}
        </p>
      </div>

      <div
        className="flex flex-col items-center gap-0.5"
        data-testid="desk-slip-qr"
        data-qr-value={fields.qrValue}
      >
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
