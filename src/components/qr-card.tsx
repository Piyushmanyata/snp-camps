"use client";

import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

export function QrCard({
  value,
  regNo,
  patientId,
}: {
  /** Absolute or relative print URL; if empty, built from patientId */
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
      <div className="rounded-2xl border border-border bg-white p-5 text-center text-sm text-muted">
        Preparing QR…
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-white p-5">
      <p className="text-sm font-medium text-muted">Registration No.</p>
      <p className="text-4xl font-bold tracking-tight text-brand">{regNo}</p>
      <div className="rounded-xl border border-border bg-white p-3">
        <QRCodeSVG
          value={payload}
          size={220}
          level="H"
          includeMargin
          bgColor="#ffffff"
          fgColor="#000000"
        />
      </div>
      <p className="text-center text-xs font-medium text-brand">
        Scan at volunteer desk to print
      </p>
      <p className="max-w-[16rem] break-all text-center text-[10px] leading-snug text-muted">
        {payload}
      </p>
    </div>
  );
}
