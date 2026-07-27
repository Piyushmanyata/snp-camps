import { QrCode } from "@/components/qr-code";
import { formatCampDay } from "@/lib/format-camp-day";

export type DeskSlipPatient = {
  id: string;
  reg_no: number;
  full_name: string;
  display_name?: string | null;
};

export type DeskSlipCamp = {
  name: string;
  venue: string | null;
  camp_date: string | null;
};

/** One filled thermal cell. */
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
    name: slot.patient.display_name || slot.patient.full_name,
    campDay: selectedDay ? formatCampDay(selectedDay) : "Not set",
    venue: slot.camp?.venue || slot.camp?.name || "—",
    qrValue: slot.qrValue,
    patientId: slot.patient.id,
  };
}

/**
 * Desk slip for camp printers (58mm thermal roll).
 */
export function PrintSheet({ slips }: Props) {
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
      <SlipBody fields={fields} />
    </article>
  );
}

function SlipBody({ fields }: { fields: SlipFields }) {
  const qrSize = 96;

  return (
    <div className="flex flex-col items-stretch gap-1.5 px-1.5 py-2">
      <p className="text-center text-[9px] font-bold uppercase tracking-wide text-[#1a3a8a]">
        SNP · Free eye camp
      </p>

      {/* Reg no — largest element; readable across a desk */}
      <div className="text-center">
        <p className="text-[10px] font-semibold uppercase tracking-wide opacity-80">
          Reg. No.
        </p>
        <p
          className="text-[42px] font-extrabold leading-none tabular-nums tracking-tight"
          data-testid="desk-slip-reg-no"
        >
          {fields.regNo}
        </p>
      </div>

      <div className="space-y-0.5 text-center">
        <p
          className="desk-slip-name text-[15px] font-bold leading-tight"
          data-testid="desk-slip-name"
        >
          {fields.name}
        </p>
        <p
          className="text-[11px] leading-snug"
          data-testid="desk-slip-camp-day"
        >
          <span className="font-semibold">Camp day</span> {fields.campDay}
        </p>
        <p
          className="desk-slip-venue text-[11px] leading-snug"
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
        <p className="text-[8px] font-semibold uppercase tracking-wide opacity-70">
          Staff scan
        </p>
      </div>
    </div>
  );
}
