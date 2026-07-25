"use client";

import { useSyncExternalStore } from "react";
import { PrintSheet } from "@/components/print-sheet";
import { readDeskPasscode } from "@/lib/desk-passcode";

type Patient = {
  id: string;
  reg_no: number;
  full_name: string;
  gender: string | null;
  age: number | null;
  address: string | null;
  phone: string | null;
  email: string | null;
};

type Camp = {
  name: string;
  venue: string | null;
  camp_date: string | null;
} | null;

/** Passcode is written before mount and does not change while mounted. */
function subscribe() {
  return () => {};
}

/**
 * Loads a just-issued desk passcode from sessionStorage (same browser tab as
 * registration/reissue) and injects it into the printable slip.
 */
export function PrintSheetWithPasscode({
  patient,
  camp,
  campDayDate,
  origin,
  today,
  qrValue,
}: {
  patient: Patient;
  camp: Camp;
  campDayDate: string | null;
  origin: string;
  today: string;
  qrValue?: string;
}) {
  const loginPasscode = useSyncExternalStore(
    subscribe,
    () => readDeskPasscode(patient.id),
    () => null,
  );

  return (
    <PrintSheet
      patient={patient}
      camp={camp}
      campDayDate={campDayDate}
      origin={origin}
      today={today}
      qrValue={qrValue}
      loginPasscode={loginPasscode}
    />
  );
}
