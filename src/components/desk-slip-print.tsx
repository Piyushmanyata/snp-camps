"use client";

import { useSyncExternalStore } from "react";
import { PrintActions, type PrintActionPatient } from "@/components/print-actions";
import {
  PrintSheet,
  type DeskSlipSlot,
} from "@/components/print-sheet";
import {
  DESK_SLIP_FORMAT_DEFAULT,
  deskSlipFormatLabel,
  getDeskSlipFormatServerSnapshot,
  readDeskSlipFormatFromStorage,
  subscribeDeskSlipFormat,
  writeDeskSlipFormatToStorage,
  type DeskSlipFormat,
} from "@/lib/desk-slip-format";

/**
 * Client shell: station format setting (localStorage) + slip + print actions.
 * Format is chosen once per print station — not auto-detected from the printer.
 *
 * A4 shows distinct multi-up slips (never duplicates). Thermal is one-up.
 */
export function DeskSlipPrint({
  slips,
  deskHref,
  deskLabel,
  autoPrint = false,
  isBatch = false,
}: {
  slips: DeskSlipSlot[];
  deskHref: "/admin" | "/volunteer";
  deskLabel: "Admin dashboard" | "Volunteer desk";
  autoPrint?: boolean;
  /** Multi-patient A4 sheet from the station batch queue. */
  isBatch?: boolean;
}) {
  const format = useSyncExternalStore(
    subscribeDeskSlipFormat,
    readDeskSlipFormatFromStorage,
    getDeskSlipFormatServerSnapshot,
  );

  function chooseFormat(next: DeskSlipFormat) {
    writeDeskSlipFormatToStorage(next);
  }

  const patients: PrintActionPatient[] = slips.map((s) => ({
    id: s.patient.id,
    regNo: s.patient.reg_no,
    name: s.patient.full_name,
    queueStatus: s.queueStatus ?? "waiting",
  }));

  // Thermal always one-up; force thermal path even if batch IDs present.
  const sheetSlips =
    format === "thermal58" ? (slips[0] ? [slips[0]] : []) : slips;
  const actionPatients =
    format === "thermal58" ? (patients[0] ? [patients[0]] : []) : patients;
  const batchMode = isBatch && format === "a4";

  return (
    <>
      <div className="no-print mb-3 flex flex-col gap-2 rounded-2xl border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-brand">
            Printer format
          </p>
          <p className="text-sm text-muted">
            Set once for this station (default{" "}
            {deskSlipFormatLabel(DESK_SLIP_FORMAT_DEFAULT)}). Saved in this
            browser.
          </p>
        </div>
        <div
          className="inline-flex rounded-xl border border-border bg-white p-0.5"
          role="group"
          aria-label="Desk slip printer format"
        >
          <FormatButton
            active={format === "a4"}
            onClick={() => chooseFormat("a4")}
            label="A4 multi-up"
          />
          <FormatButton
            active={format === "thermal58"}
            onClick={() => chooseFormat("thermal58")}
            label="58mm thermal"
          />
        </div>
      </div>

      <PrintActions
        className="no-print mb-4"
        patients={actionPatients}
        deskHref={deskHref}
        deskLabel={deskLabel}
        autoPrint={autoPrint}
        isBatch={batchMode}
      />

      <PrintSheet format={format} slips={sheetSlips} />

      <p className="no-print mt-3 text-center text-xs text-muted">
        {format === "a4" ? (
          <>
            A4 · up to 4 <strong>distinct</strong> slips per sheet with cut
            lines · empty cells stay empty · Portrait · QR is for{" "}
            <strong>staff scan only</strong>.
          </>
        ) : (
          <>
            58mm thermal roll · one patient per print · QR is for{" "}
            <strong>staff scan only</strong>.
          </>
        )}{" "}
        Status for the patient is a separate SMS link when configured.
      </p>
    </>
  );
}

function FormatButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        active
          ? "min-h-12 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white"
          : "min-h-12 rounded-lg px-3 py-2 text-sm font-semibold text-foreground hover:bg-brand-soft"
      }
    >
      {label}
    </button>
  );
}
