import { connection } from "next/server";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { formatCampDay } from "@/lib/format-camp-day";
import { checkRateLimit } from "@/lib/rate-limit";
import { checkDistributedRateLimit } from "@/lib/distributed-rate-limit";
import { isStatusTokenFormat } from "@/lib/status-token";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { QrCode } from "@/components/qr-code";
import { ErrorBox } from "@/components/ui";
import { StatusAutoRefresh } from "@/components/status-auto-refresh";
import { getPatientStatusGuidance } from "@/lib/patient-status-guidance";
import { mapStatusRpcRow, type StatusRpcRow } from "@/lib/status-view";

const STATUS_IP_RATE_LIMIT = {
  scope: "status-ip",
  limit: 1_200,
  windowMs: 60_000,
  keyType: "ip" as const,
};

const STATUS_TOKEN_RATE_LIMIT = {
  scope: "status-token",
  limit: 12,
  windowMs: 60_000,
  keyType: "subject" as const,
};

export default async function PatientStatusPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  await connection();
  const { token: raw } = await params;
  const token = raw.trim().toLowerCase();

  const requestHeaders = await headers();
  const rateRequest = new Request("https://snp-camps.invalid/status", {
    headers: new Headers(requestHeaders),
  });
  if (!isStatusTokenFormat(token)) notFound();

  const ipRate = checkRateLimit(rateRequest, STATUS_IP_RATE_LIMIT);
  const tokenRate = checkRateLimit(rateRequest, {
    ...STATUS_TOKEN_RATE_LIMIT,
    identifier: token,
  });
  if (!ipRate.allowed || !tokenRate.allowed) {
    const retryAfter = Math.max(
      1,
      Number(ipRate.headers["Retry-After"] ?? 1),
      Number(tokenRate.headers["Retry-After"] ?? 1),
    );
    redirect(`/api/status-rate-limit?retry=${retryAfter}`);
  }

  const admin = createServiceRoleClient();
  if (!admin) notFound();

  const durableIp = await checkDistributedRateLimit(rateRequest, admin, {
    ...STATUS_IP_RATE_LIMIT,
  });
  const durableToken = await checkDistributedRateLimit(rateRequest, admin, {
    ...STATUS_TOKEN_RATE_LIMIT,
    identifier: token,
  });
  if (durableIp.unavailable || durableToken.unavailable) {
    redirect("/api/status-rate-limit?status=503&retry=1");
  }
  if (!durableIp.allowed || !durableToken.allowed) {
    redirect(
      `/api/status-rate-limit?retry=${Math.max(
        1,
        durableIp.retryAfterSeconds,
        durableToken.retryAfterSeconds,
      )}`,
    );
  }

  const { data, error } = await admin.rpc("patient_status_by_token", {
    p_token: token,
  });

  if (error) {
    return (
      <main
        id="main"
        lang="hi-Latn"
        className="mx-auto max-w-md px-4 py-10 text-foreground"
      >
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
    <main
      id="main"
      lang="hi-Latn"
      className="mx-auto max-w-md px-4 py-10 text-foreground"
    >
      <StatusAutoRefresh />
      <div className="space-y-5">
        <div className="text-center">
          <h1 className="text-xl font-bold tracking-tight text-brand">
            Aapka camp status
          </h1>
          <p className="mt-0.5 text-[0.8125rem] text-muted">
            Apne camp din par venue par pahunchein
          </p>
        </div>

        <section
          aria-labelledby="current-status-heading"
          className={
            statusGuidance.tone === "complete"
              ? "rounded-2xl border border-brand/25 bg-success-soft p-4 text-foreground"
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
