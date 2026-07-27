/**
 * Server-side load of desk-slip slots for print routes (#64).
 * Auth + RLS applied by the caller's supabase client.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { isPatientUuid, patientScanUrl } from "@/lib/qr";
import type { DeskSlipSlot } from "@/components/print-sheet";
import type { QueueStatus } from "@/lib/types";

export type LoadedPrintPatient = DeskSlipSlot & {
  queueStatus: QueueStatus;
  age: number | null;
  gender: string | null;
  /** Camp registration print mode: true → Prescription Sheet (#108). */
  paperFallbackMode: boolean;
};

type PatientRow = {
  id: string;
  reg_no: number;
  full_name: string;
  age: number | null;
  gender: string | null;
  queue_status: QueueStatus;
  camps:
    | {
        name: string;
        venue: string | null;
        camp_date: string | null;
        paper_fallback_mode?: boolean | null;
      }
    | {
        name: string;
        venue: string | null;
        camp_date: string | null;
        paper_fallback_mode?: boolean | null;
      }[]
    | null;
  camp_days: { day_date: string } | { day_date: string }[] | null;
};

function campFromRow(row: PatientRow) {
  const campRel = row.camps;
  return Array.isArray(campRel) ? campRel[0] ?? null : campRel;
}

function campDayFromRow(row: PatientRow): string | null {
  const dayRel = row.camp_days;
  if (Array.isArray(dayRel)) return dayRel[0]?.day_date ?? null;
  return dayRel?.day_date ?? null;
}

function toSlot(row: PatientRow, origin: string): LoadedPrintPatient {
  const camp = campFromRow(row);
  return {
    patient: {
      id: row.id,
      reg_no: row.reg_no,
      full_name: row.full_name,
    },
    camp: camp
      ? {
          name: camp.name,
          venue: camp.venue,
          camp_date: camp.camp_date,
        }
      : null,
    campDayDate: campDayFromRow(row),
    qrValue: patientScanUrl(row.id, origin),
    queueStatus: row.queue_status,
    age: row.age,
    gender: row.gender,
    paperFallbackMode: Boolean(camp?.paper_fallback_mode),
  };
}

/**
 * Load distinct authorized patients by id, preserving request order.
 * Missing/unauthorized IDs are omitted (never fabricate duplicates).
 */
export async function loadPrintSlips(
  supabase: SupabaseClient,
  ids: readonly string[],
  origin: string,
): Promise<LoadedPrintPatient[]> {
  const clean: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!isPatientUuid(id) || seen.has(id)) continue;
    seen.add(id);
    clean.push(id);
  }
  if (clean.length === 0) return [];

  const { data, error } = await supabase
    .from("patients")
    .select(
      "id, reg_no, full_name, age, gender, queue_status, camps(name, venue, camp_date, paper_fallback_mode), camp_days(day_date)",
    )
    .in("id", clean);

  if (error || !data) return [];

  const byId = new Map<string, PatientRow>();
  for (const row of data as PatientRow[]) {
    byId.set(row.id.toLowerCase(), row);
  }

  const out: LoadedPrintPatient[] = [];
  for (const id of clean) {
    const row = byId.get(id);
    if (!row) continue;
    out.push(toSlot(row, origin));
  }
  return out;
}
