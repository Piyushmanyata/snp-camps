"use client";

import { PrintActions, type PrintActionPatient } from "@/components/print-actions";
import { PrintSheet, type DeskSlipSlot } from "@/components/print-sheet";

/**
 * Client shell: station slip + print actions.
 * Thermal 58mm is the only desk slip format.
 */
export function DeskSlipPrint({
  slips,
  deskHref,
  deskLabel,
  autoPrint = false,
}: {
  slips: DeskSlipSlot[];
  deskHref: "/admin" | "/volunteer";
  deskLabel: "Admin dashboard" | "Volunteer desk";
  autoPrint?: boolean;
}) {
  const patients: PrintActionPatient[] = slips.map((s) => ({
    id: s.patient.id,
    regNo: s.patient.reg_no,
    name: s.patient.full_name,
    queueStatus: s.queueStatus ?? "waiting",
  }));

  const sheetSlips = slips[0] ? [slips[0]] : [];
  const actionPatients = patients[0] ? [patients[0]] : [];

  return (
    <>
      <PrintActions
        className="no-print mb-4"
        patients={actionPatients}
        deskHref={deskHref}
        deskLabel={deskLabel}
        autoPrint={autoPrint}
      />

      <PrintSheet slips={sheetSlips} />

      <p className="no-print mt-3 text-center text-xs text-muted">
        58mm thermal roll · one patient per print · QR is for{" "}
        <strong>staff scan only</strong>. Status for the patient is a separate
        SMS link when configured.
      </p>
    </>
  );
}
