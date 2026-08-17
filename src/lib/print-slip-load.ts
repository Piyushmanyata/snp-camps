
import type { SupabaseClient } from "@supabase/supabase-js";
import { isPatientUuid, patientScanUrl } from "@/lib/qr";
import type { PrescriptionSheetPatient } from "@/components/prescription-sheet";
import type { QueueStatus } from "@/lib/types";

export type LoadedPrintPatient = {
  patient: PrescriptionSheetPatient;
  camp: { name: string; venue: string | null } | null;
  campId: string;
  campDayDate: string | null;
  qrValue: string;
  queueStatus: QueueStatus;
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
  camp_id: string;
  camp_name: string;
  venue: string | null;
  prescription_template: unknown;
  day_date: string;
};

function toLoaded(row: PatientRow, origin: string, published?: unknown): LoadedPrintPatient {
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
    camp: { name: row.camp_name, venue: row.venue },
    campId: row.camp_id,
    campDayDate: row.day_date,
    qrValue: patientScanUrl(row.id, origin),
    queueStatus: row.queue_status,
    prescriptionTemplate: published ?? row.prescription_template ?? null,
  };
}

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

  const out: LoadedPrintPatient[] = [];
  const templates = new Map<string, unknown>();
  for (const id of clean) {
    const { data, error } = await supabase.rpc("print_patient", {
      p_patient_id: id,
    });
    if (error || !data) continue;
    const row = (Array.isArray(data) ? data[0] : data) as PatientRow | null;
    if (!row) continue;

    let published = templates.get(row.camp_id);
    if (!templates.has(row.camp_id)) {
      const result = await supabase.rpc("published_prescription_template", {
        p_camp_id: row.camp_id,
      });
      published = result.data ?? null;
      templates.set(row.camp_id, published);
    }
    out.push(toLoaded(row, origin, published));
  }
  return out;
}
