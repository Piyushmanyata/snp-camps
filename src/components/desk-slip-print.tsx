"use client";

import { useSyncExternalStore } from "react";
import { PrintActions } from "@/components/print-actions";
import {
  PrintSheet,
  type DeskSlipCamp,
  type DeskSlipPatient,
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
import type { QueueStatus } from "@/lib/types";

/**
 * Client shell: station format setting (localStorage) + slip + print actions.
 * Format is chosen once per print station — not auto-detected from the printer.
 */
export function DeskSlipPrint({
  patient,
  camp,
  campDayDate,
  qrValue,
  queueStatus,
  deskHref,
  deskLabel,
  autoPrint = false,
}: {
  patient: DeskSlipPatient;
  camp: DeskSlipCamp | null;
  campDayDate: string | null;
  qrValue: string;
  queueStatus: QueueStatus;
  deskHref: "/admin" | "/volunteer";
  deskLabel: "Admin dashboard" | "Volunteer desk";
  autoPrint?: boolean;
}) {
  const format = useSyncExternalStore(
    subscribeDeskSlipFormat,
    readDeskSlipFormatFromStorage,
    getDeskSlipFormatServerSnapshot,
  );

  function chooseFormat(next: DeskSlipFormat) {
    writeDeskSlipFormatToStorage(next);
  }

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
        patientId={patient.id}
        regNo={patient.reg_no}
        name={patient.full_name}
        queueStatus={queueStatus}
        deskHref={deskHref}
        deskLabel={deskLabel}
        autoPrint={autoPrint}
      />

      <PrintSheet
        format={format}
        patient={patient}
        camp={camp}
        campDayDate={campDayDate}
        qrValue={qrValue}
      />

      <p className="no-print mt-3 text-center text-xs text-muted">
        {format === "a4" ? (
          <>
            A4 · 4 slips per sheet with cut lines · Portrait · QR is for{" "}
            <strong>staff scan only</strong>.
          </>
        ) : (
          <>
            58mm thermal roll · QR is for <strong>staff scan only</strong>.
          </>
        )}{" "}
        Status for the patient is a separate SMS link when configured.{" "}
        {queueStatus === "seen" ? (
          <>The consultation is complete; reprinting does not change its status.</>
        ) : queueStatus === "waiting" ? (
          <>The patient is in queue and waiting for a doctor.</>
        ) : (
          <>
            Use <strong>Check in &amp; print</strong> before the patient proceeds
            to a doctor.
          </>
        )}
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
