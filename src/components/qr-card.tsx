"use client";

import { useMemo } from "react";
import { QRCodeSVG } from "qrcode.react";
import { patientPrintUrl } from "@/lib/qr";

export function QrCard({
  value,
  regNo,
  patientId,
}: {
  value?: string;
  regNo: number;
  patientId?: string;
}) {
  // Prefer explicit value (full URL from parent). Fall back to site URL + patientId.
  // No useEffect/setState — avoids cascading renders and hydration flicker.
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
        <p className="text-sm font-semibold text-brand">Show at volunteer desk</p>
        <p className="mt-0.5 text-xs text-muted">
          Scan to join the queue · then print when called
        </p>
      </div>
    </div>
  );
}
