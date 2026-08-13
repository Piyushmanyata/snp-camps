/**
 * Public status projection for `/s/<token>`.
 *
 * Lives here rather than in the page so tests exercise the real mapper: the
 * node runner cannot import a `.tsx` module, and a re-implementation inside the
 * test would keep passing while the page rotted.
 *
 * There is no position (ADR 0013) — a residual `queue_position` from an older
 * deployment is dropped rather than surfaced.
 */

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
