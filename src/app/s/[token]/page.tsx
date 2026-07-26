import { connection } from "next/server";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { formatCampDay } from "@/lib/format-camp-day";
import { checkRateLimit } from "@/lib/rate-limit";
import { isStatusTokenFormat } from "@/lib/status-token";
import { createServiceRoleClient } from "@/lib/supabase/admin";

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
};

/**
 * Map a successful patient_status_by_token row to the status-page view model.
 * Pure helper — unit-tested without rendering the RSC tree.
 */
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
  };
}

function StatusRefresh() {
  return <meta httpEquiv="refresh" content="30" />;
}

/**
 * Passwordless patient status — zero client JS (Server Component only).
 * Unknown / malformed tokens → same plain not-found (no oracle).
 * Queue position comes from atomic FCFS RPC (#70); never a secondary count.
 */
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
  // Keep rate-limited requests indistinguishable from unknown or expired tokens.
  if (!rate.allowed) notFound();

  if (!isStatusTokenFormat(token)) notFound();

  const admin = createServiceRoleClient();
  if (!admin) notFound();

  const { data, error } = await admin.rpc("patient_status_by_token", {
    p_token: token,
  });

  // Calculation / RPC failure → safe retryable error (not notFound, not fabricated position).
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

  return (
    <>
      <head>
        <StatusRefresh />
      </head>
      <main id="main" className="mx-auto max-w-md px-4 py-10 text-foreground">
        <h1 className="text-xl font-bold tracking-tight">Camp status</h1>
        <dl className="mt-6 space-y-4 text-[1.0625rem]">
          <div>
            <dt className="text-sm font-medium text-muted">Name</dt>
            <dd className="font-semibold">{view.fullName}</dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-muted">Registration number</dt>
            <dd className="font-semibold tabular">#{view.regNo}</dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-muted">Camp</dt>
            <dd className="font-semibold">{view.campName}</dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-muted">Date</dt>
            <dd className="font-semibold">
              {view.dayDate ? formatCampDay(view.dayDate) : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-muted">Venue</dt>
            <dd className="font-semibold">{view.venue}</dd>
          </div>
          {view.queuePosition != null ? (
            <div>
              <dt className="text-sm font-medium text-muted">Queue position</dt>
              <dd className="font-semibold tabular">{view.queuePosition}</dd>
            </div>
          ) : null}
        </dl>
      </main>
    </>
  );
}
