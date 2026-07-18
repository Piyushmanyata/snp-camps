"use client";

import { useMemo } from "react";
import { QrCode } from "@/components/qr-code";
import { patientScanUrl } from "@/lib/qr";

/** Patient phone / confirmation: big reg no + staff-scan QR. Not for login. */
export function QrCard({
  value,
  regNo,
  patientId,
}: {
  value?: string;
  regNo: number;
  patientId?: string;
}) {
  const payload = useMemo(() => {
    if (value && value.length > 8) return value;
    if (patientId) return patientScanUrl(patientId);
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
    <div className="flex flex-col items-center gap-4 rounded-2xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
      <div className="text-center">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">
          Registration no.
        </p>
        <p
          className="tabular mt-1 text-5xl font-bold tracking-tight text-brand sm:text-6xl"
          translate="no"
        >
          {regNo}
        </p>
      </div>
      <div className="rounded-2xl border border-border bg-white p-4 shadow-inner">
        <QrCode
          value={payload}
          size={220}
          level="H"
          includeMargin
          fgColor="#0a5c3a"
        />
      </div>
      <div className="text-center">
        <p className="text-sm font-semibold text-brand">
          Show this QR to camp staff
        </p>
        <p className="prose-help mt-1 text-xs text-muted">
          Volunteers scan to assign a doctor · not a login code
        </p>
      </div>
    </div>
  );
}
