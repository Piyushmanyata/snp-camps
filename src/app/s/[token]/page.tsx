import { connection } from "next/server";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { formatCampDay } from "@/lib/format-camp-day";
import { checkRateLimit } from "@/lib/rate-limit";
import { isStatusTokenFormat } from "@/lib/status-token";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { QrCode } from "@/components/qr-code";
import { ErrorBox } from "@/components/ui";
import { StatusAutoRefresh } from "@/components/status-auto-refresh";
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
  };
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
      <main id="main" className="mx-auto max-w-md px-4 py-10 text-foreground">
        <StatusAutoRefresh />
        <h1 className="text-xl font-bold tracking-tight">Camp status</h1>
        <div className="mt-6">
          <ErrorBox message="Status abhi load nahi ho paaya. Thodi der baad refresh karein." />
        </div>
      </main>
    );
  }

  const rows = Array.isArray(data) ? data : data ? [data] : [];
  if (rows.length === 0) notFound();

  const view = mapStatusRpcRow(rows[0] as StatusRpcRow);
  const qrValue = view.patientId ? `snp:${view.patientId}` : `reg:${view.regNo}`;
  const statusGuidance = getPatientStatusGuidance(view.queueStatus);

  return (
    <main id="main" className="mx-auto max-w-md px-4 py-10 text-foreground">
      <StatusAutoRefresh />
      <div className="space-y-5">
        <div className="text-center">
          <h1 className="text-xl font-bold tracking-tight text-brand">
            Aapka camp status
          </h1>
          <p className="mt-0.5 text-[0.8125rem] text-muted">
            Line pehle-aao-pehle-paao ke hisaab se chalti hai
          </p>
        </div>

        {/* Queue position first: on camp day it is the only number that matters. */}
        {view.queuePosition != null ? (
          <div className="rounded-2xl border border-brand/25 bg-brand-soft p-5 text-center">
            <p className="text-[0.8125rem] font-bold uppercase tracking-wider text-brand">
              Line mein aapka number
            </p>
            <p className="tabular mt-1 text-6xl font-extrabold leading-none text-brand">
              {view.queuePosition}
            </p>
          </div>
        ) : null}

        <section
          aria-labelledby="current-status-heading"
          className={
            statusGuidance.tone === "complete"
              ? "rounded-2xl border border-brand/25 bg-success-soft p-4 text-foreground"
              : statusGuidance.tone === "waiting"
                ? "rounded-2xl border border-warning/30 bg-warning-soft p-4 text-foreground"
                : "rounded-2xl border border-border bg-card p-4 text-foreground"
          }
        >
          <h2
            id="current-status-heading"
            className="text-[0.8125rem] font-semibold uppercase tracking-wider text-muted"
          >
            Abhi ki sthiti
          </h2>
          <p className="mt-1 text-lg font-bold">{statusGuidance.label}</p>
          <p className="mt-1 text-[0.9375rem]">{statusGuidance.instruction}</p>
        </section>

        <div className="flex flex-col items-center justify-center space-y-3 rounded-2xl border border-border bg-card p-5">
          <div className="rounded-xl border border-border bg-white p-2.5">
            <QrCode value={qrValue} size={140} level="M" />
          </div>
          <p className="text-center text-[0.8125rem] font-semibold text-muted">
            Yeh QR desk par dikhayein · Reg{" "}
            <span className="tabular font-bold text-brand">#{view.regNo}</span>
          </p>
        </div>

        <dl className="space-y-4 rounded-2xl border border-border bg-card p-5 text-[1.0625rem]">
          <div>
            <dt className="text-[0.8125rem] font-semibold uppercase tracking-wider text-muted">
              Naam
            </dt>
            <dd className="text-lg font-bold text-foreground">{view.fullName}</dd>
          </div>
          <div>
            <dt className="text-[0.8125rem] font-semibold uppercase tracking-wider text-muted">
              Registration number
            </dt>
            <dd className="tabular font-bold text-foreground">#{view.regNo}</dd>
          </div>
          <div>
            <dt className="text-[0.8125rem] font-semibold uppercase tracking-wider text-muted">
              Camp
            </dt>
            <dd className="font-semibold text-foreground">{view.campName}</dd>
          </div>
          <div>
            <dt className="text-[0.8125rem] font-semibold uppercase tracking-wider text-muted">
              Camp ka din
            </dt>
            <dd className="font-semibold text-foreground">
              {view.dayDate ? formatCampDay(view.dayDate) : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-[0.8125rem] font-semibold uppercase tracking-wider text-muted">
              Jagah
            </dt>
            <dd className="font-semibold text-foreground">{view.venue}</dd>
          </div>
        </dl>
      </div>
    </main>
  );
}
