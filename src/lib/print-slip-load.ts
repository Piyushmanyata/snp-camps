/**
 * Server-side load of the patient data the printed prescription needs.
 * Auth + RLS applied by the caller's supabase client.
 *
 * Desk slips were retired — a camp day prints prescriptions and nothing else —
 * so this loads the identity block of the prescription sheet.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { isPatientUuid, patientScanUrl } from "@/lib/qr";
import type { PrescriptionSheetPatient } from "@/components/prescription-sheet";
import type { QueueStatus } from "@/lib/types";

export type LoadedPrintPatient = {
  patient: PrescriptionSheetPatient;
  camp: { name: string; venue: string | null } | null;
  campDayDate: string | null;
  qrValue: string;
  queueStatus: QueueStatus;
  /** Per-camp prescription template overrides, or null for the default. */
  prescriptionTemplate: unknown;
};

type PatientRow = {
  id: string;
  reg_no: number;
  full_name: string;
  age: number | null;
  gender: string | null;
  address: string | null;
  phone: string | null;
  queue_status: QueueStatus;
  camps:
    | { id: string; name: string; venue: string | null; prescription_template?: unknown }
    | { id: string; name: string; venue: string | null; prescription_template?: unknown }[]
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

function toLoaded(row: PatientRow, origin: string, published?: unknown): LoadedPrintPatient {
  const camp = campFromRow(row);
  return {
    patient: {
      id: row.id,
      reg_no: row.reg_no,
      full_name: row.full_name,
      age: row.age,
      gender: row.gender,
      address: row.address,
      phone: row.phone,
    },
    camp: camp ? { name: camp.name, venue: camp.venue } : null,
    campDayDate: campDayFromRow(row),
    qrValue: patientScanUrl(row.id, origin),
    queueStatus: row.queue_status,
    prescriptionTemplate: published ?? camp?.prescription_template ?? null,
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
      "id, reg_no, full_name, age, gender, address, phone, queue_status, camps(id, name, venue, prescription_template), camp_days(day_date)",
    )
    .in("id", clean);

  if (error || !data) return [];

  const byId = new Map<string, PatientRow>();
  for (const row of data as PatientRow[]) {
    byId.set(row.id.toLowerCase(), row);
  }

  const out: LoadedPrintPatient[] = [];
  const templates = new Map<string, unknown>();
  for (const id of clean) {
    const row = byId.get(id);
    if (!row) continue;
    const camp = campFromRow(row);
    let published = camp ? templates.get(camp.id) : undefined;
    if (camp && !templates.has(camp.id)) {
      const result = await supabase.rpc("published_prescription_template", {
        p_camp_id: camp.id,
      });
      published = result.data ?? null;
      templates.set(camp.id, published);
    }
    out.push(toLoaded(row, origin, published));
  }
  return out;
}
