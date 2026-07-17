"use client";

import { useMemo } from "react";
import { QRCodeSVG } from "qrcode.react";
import { patientPrintUrl } from "@/lib/qr";

export function QrCard({
  value,
  regNo,
  patientId,
  staffHint = false,
}: {
  value?: string;
  regNo: number;
  patientId?: string;
  /** Desk registration: wording for volunteer/admin */
  staffHint?: boolean;
}) {
  const payload = useMemo(() => {
    if (value && value.length > 8) return value;
    if (patientId) return patientPrintUrl(patientId);
    return value || "";
  }, [value, patientId]);

  if (!payload) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-card p-6 text-center text-sm text-muted">
        Preparing QR…
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
      <div className="text-center">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">
          Registration no.
        </p>
        <p className="text-5xl font-bold tabular-nums tracking-tight text-brand">
          {regNo}
        </p>
      </div>
      <div className="rounded-2xl border border-border bg-white p-4 shadow-inner">
        <QRCodeSVG
          value={payload}
          size={200}
          level="H"
          includeMargin
          bgColor="#ffffff"
          fgColor="#0a5c3a"
        />
      </div>
      <div className="text-center">
        {staffHint ? (
          <>
            <p className="text-sm font-semibold text-brand">
              Patient phone login
            </p>
            <p className="mt-0.5 text-xs text-muted">
              They scan → instant login · desk scan → queue · print → seen
            </p>
          </>
        ) : (
          <>
            <p className="text-sm font-semibold text-brand">Scan to open profile</p>
            <p className="mt-0.5 text-xs text-muted">
              Instant login · show same QR at desk for queue &amp; print
            </p>
          </>
        )}
      </div>
    </div>
  );
}
