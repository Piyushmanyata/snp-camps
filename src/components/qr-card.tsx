"use client";

import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

export function QrCard({
  value,
  regNo,
  patientId,
}: {
  value?: string;
  regNo: number;
  patientId?: string;
}) {
  const [payload, setPayload] = useState(value || "");

  useEffect(() => {
    if (value && value.length > 8) {
      setPayload(value);
      return;
    }
    if (patientId) {
      const site = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
      const origin =
        site ||
        (typeof window !== "undefined" ? window.location.origin : "");
      setPayload(origin ? `${origin}/print/${patientId}` : patientId);
    }
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
          They scan this QR to open your prescription
        </p>
      </div>
    </div>
  );
}
