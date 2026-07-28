import { connection } from "next/server";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { formatCampDay } from "@/lib/format-camp-day";
import { checkRateLimit } from "@/lib/rate-limit";
import { isStatusTokenFormat } from "@/lib/status-token";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { QrCode } from "@/components/qr-code";
import { getPatientStatusGuidance } from "@/lib/patient-status-guidance";

const STATUS_RATE_LIMIT = {
  scope: "status-page",
  limit: 12,
  windowMs: 60_000,
};

type StatusRpcRow = {
  full_name: string;
  reg_no: number;
  queue_status: string;
  queue_position: number | null;
  camp_name: string | null;
  venue: string | null;
  day_date: string | null;
  patient_id?: string | null;
  pending_orders?: string[] | null;
};

export function mapStatusRpcRow(row: StatusRpcRow) {
  return {
    fullName: row.full_name,
    regNo: row.reg_no,
    queueStatus: row.queue_status,
    queuePosition:
      row.queue_status === "waiting" && row.queue_position != null
        ? Number(row.queue_position)
        : null,
    campName: row.camp_name?.trim() ? row.camp_name : "—",
    venue: row.venue?.trim() ? row.venue : "—",
    dayDate: row.day_date ? String(row.day_date) : null,
    patientId: row.patient_id || null,
    pendingOrders: Array.isArray(row.pending_orders) ? row.pending_orders : [],
  };
}

function StatusRefresh() {
  return <meta httpEquiv="refresh" content="30" />;
}

export default async function PatientStatusPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  await connection();
  const { token: raw } = await params;
  const token = raw.trim().toLowerCase();

  const requestHeaders = await headers();
  const rate = checkRateLimit(
    new Request("https://snp-camps.invalid/status", {
      headers: new Headers(requestHeaders),
    }),
    STATUS_RATE_LIMIT,
  );
  if (!rate.allowed) notFound();

  if (!isStatusTokenFormat(token)) notFound();

  const admin = createServiceRoleClient();
  if (!admin) notFound();

  const { data, error } = await admin.rpc("patient_status_by_token", {
    p_token: token,
  });

  if (error) {
    return (
      <>
        <head>
          <StatusRefresh />
        </head>
        <main id="main" className="mx-auto max-w-md px-4 py-10 text-foreground">
          <h1 className="text-xl font-bold tracking-tight">Camp status</h1>
          <div
            role="alert"
            className="mt-6 rounded-xl border border-red-200 bg-danger-soft px-3.5 py-3 text-[0.9375rem] text-danger"
          >
            <p className="font-medium">
              Status could not be loaded. Please refresh and try again.
            </p>
          </div>
        </main>
      </>
    );
  }

  const rows = Array.isArray(data) ? data : data ? [data] : [];
  if (rows.length === 0) notFound();

  const view = mapStatusRpcRow(rows[0] as StatusRpcRow);
  const qrValue = view.patientId ? `snp:${view.patientId}` : `reg:${view.regNo}`;
  const statusGuidance = getPatientStatusGuidance(
    view.queueStatus,
    view.pendingOrders.length,
  );

  const treatmentLabels: Record<string, string> = {
    pharmacy: "Medicines",
    spectacles: "Spectacles",
    ot: "OT / Surgery",
  };

  return (
    <>
      <head>
        <StatusRefresh />
      </head>
      <main id="main" className="mx-auto max-w-md px-4 py-10 text-foreground">
        <div className="space-y-6">
          <div className="text-center">
            <h1 className="text-xl font-bold tracking-tight text-brand">Camp Status</h1>
            <p className="text-xs text-muted mt-0.5">Live FCFS status & queue info</p>
          </div>

          {/* Patient QR Code Card */}
          <div className="flex flex-col items-center justify-center rounded-2xl border border-border bg-card p-5 shadow-sm space-y-3">
            <div className="rounded-xl border border-border bg-white p-2.5 shadow-inner">
              <QrCode value={qrValue} size={140} level="M" />
            </div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted">
              Patient QR · Reg #{view.regNo}
            </p>
          </div>

          <section
            aria-labelledby="current-status-heading"
            className={
              statusGuidance.tone === "complete"
                ? "rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-950"
                : statusGuidance.tone === "waiting"
                  ? "rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-950"
                  : "rounded-2xl border border-brand/20 bg-brand-soft/50 p-4 text-foreground"
            }
          >
            <h2
              id="current-status-heading"
              className="text-xs font-semibold uppercase tracking-wider"
            >
              Current status
            </h2>
            <p className="mt-1 text-lg font-bold">{statusGuidance.label}</p>
            <p className="mt-1 text-sm">{statusGuidance.instruction}</p>
          </section>

          <dl className="rounded-2xl border border-border bg-card p-5 space-y-4 text-[1.0625rem] shadow-sm">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wider text-muted">Name</dt>
              <dd className="font-bold text-foreground text-lg">{view.fullName}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wider text-muted">Registration Number</dt>
              <dd className="font-bold text-foreground tabular">#{view.regNo}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wider text-muted">Camp Name</dt>
              <dd className="font-semibold text-foreground">{view.campName}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wider text-muted">Camp Date</dt>
              <dd className="font-semibold text-foreground">
                {view.dayDate ? formatCampDay(view.dayDate) : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wider text-muted">Venue</dt>
              <dd className="font-semibold text-foreground">{view.venue}</dd>
            </div>
            {view.queuePosition != null ? (
              <div className="rounded-xl border border-brand/20 bg-brand-soft/50 p-3">
                <dt className="text-xs font-semibold uppercase tracking-wider text-brand">Live Queue Position</dt>
                <dd className="text-2xl font-extrabold tabular text-brand">{view.queuePosition}</dd>
              </div>
            ) : null}

            {view.pendingOrders.length > 0 ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3 space-y-1">
                <dt className="text-xs font-semibold uppercase tracking-wider text-amber-900">Awaited Treatments</dt>
                <dd className="flex flex-wrap gap-1.5">
                  {view.pendingOrders.map((k) => (
                    <span key={k} className="rounded-md bg-white border border-amber-200 px-2 py-0.5 text-xs font-bold text-amber-950 shadow-xs">
                      {treatmentLabels[k] || k}
                    </span>
                  ))}
                </dd>
              </div>
            ) : null}
          </dl>
        </div>
      </main>
    </>
  );
}
