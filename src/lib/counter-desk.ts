import type { QueueStatus } from "@/lib/types";

export type CounterStationKind = "pharmacy" | "spectacles" | "ot";

export const COUNTER_STATIONS: { kind: CounterStationKind; label: string; shortLabel: string; hint: string }[] = [
  { kind: "pharmacy", label: "Pharmacy (Medicines)", shortLabel: "Pharmacy", hint: "Dispense prescribed medicines" },
  { kind: "spectacles", label: "Spectacles (Glasses)", shortLabel: "Spectacles", hint: "Issue reading / bifocal glasses" },
  { kind: "ot", label: "OT (Surgery & Procedure)", shortLabel: "OT / Surgery", hint: "Surgery consent & referral" },
];

export type TreatmentOrderRow = {
  id: string;
  prescription_id: string | null;
  patient_id: string;
  camp_id: string;
  kind: CounterStationKind;
  status: "pending" | "fulfilled" | "deferred" | "cancelled";
  created_at: string;
  closed_at: string | null;
  closed_by: string | null;
  deferred_date: string | null;
  deferred_venue: string | null;
  scheduled_camp_day_id?: string | null;
  scheduled_day_date?: string | null;
};

export type PrescriptionDetails = {
  id: string;
  diagnosis: string | null;
  examination: string | null;
  medicines: string | null;
  advice: string | null;
  spectacles_type: "fixed" | "bifocal" | null;
  doctor_name: string | null;
};

export type CounterPatientRecord = {
  id: string;
  reg_no: number;
  full_name: string;
  phone: string | null;
  queue_status: QueueStatus;
  camp_id: string;
  prescription: PrescriptionDetails | null;
  orders: TreatmentOrderRow[];
  /** Derived completion: seen + no remaining pending treatment orders */
  isCompleted: boolean;
};

export type CounterStationQueueItem = {
  order_id: string;
  created_at: string;
  kind: CounterStationKind;
  patient_id: string;
  reg_no: number;
  full_name: string;
  queue_status: QueueStatus;
  scheduled_camp_day_id?: string | null;
  scheduled_day_date?: string | null;
};

/** Compute derived completion state per Rule 1: seen + 0 pending orders. */
export function isPatientCompletedDerived(
  queueStatus: string,
  orders: { status: string }[],
): boolean {
  if (queueStatus !== "seen") return false;
  if (!orders || orders.length === 0) return true;
  return orders.every((o) => o.status !== "pending");
}
