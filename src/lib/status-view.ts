
export type StatusRpcRow = {
  reg_no: number;
  queue_status: string;
  camp_name: string | null;
  venue: string | null;
  day_date: string | null;
  patient_id?: string | null;
};

export type StatusView = {
  regNo: number;
  queueStatus: string;
  campName: string;
  venue: string;
  dayDate: string | null;
  patientId: string | null;
};

export function mapStatusRpcRow(row: StatusRpcRow): StatusView {
  return {
    regNo: row.reg_no,
    queueStatus: row.queue_status,
    campName: row.camp_name?.trim() ? row.camp_name : "—",
    venue: row.venue?.trim() ? row.venue : "—",
    dayDate: row.day_date ? String(row.day_date) : null,
    patientId: row.patient_id || null,
  };
}
