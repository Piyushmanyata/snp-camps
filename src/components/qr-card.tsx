"use client";

import { QRCodeSVG } from "qrcode.react";

export function QrCard({ value, regNo }: { value: string; regNo: number }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-white p-5">
      <p className="text-sm font-medium text-muted">Registration No.</p>
      <p className="text-4xl font-bold tracking-tight text-brand">{regNo}</p>
      <QRCodeSVG value={value} size={180} level="M" includeMargin />
      <p className="max-w-xs text-center text-xs text-muted">
        Show this QR at the desk. Volunteer scans to print prescription.
      </p>
    </div>
  );
}
