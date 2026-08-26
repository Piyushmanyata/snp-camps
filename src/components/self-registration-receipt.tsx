"use client";

import { useEffect, useRef } from "react";
import { QrCode } from "@/components/qr-code";
import { formatCampDay } from "@/lib/format-camp-day";

export type SelfRegistrationReceiptData = {
  patientId: string;
  registrationNumber: number;
  dayDate: string | null;
  existing?: boolean;
};

export function SelfRegistrationReceipt({
  result,
  venue,
}: {
  result: SelfRegistrationReceiptData;
  venue: string | null;
}) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => headingRef.current?.focus(), []);

  return (
    <section aria-labelledby="registration-success" className="space-y-5">
      <h2
        ref={headingRef}
        id="registration-success"
        tabIndex={-1}
        className="text-xl font-bold outline-none"
      >
        {result.existing ? "Already registered" : "Registration complete"}
      </h2>
      <p className="rounded-2xl bg-brand-soft p-6 text-center">
        <span className="block text-xs font-bold uppercase text-brand">
          {result.existing ? "Your registration number" : "Registration number"}
        </span>
        <strong className="text-5xl tracking-tight">
          #{result.registrationNumber}
        </strong>
      </p>

      <div className="flex flex-col items-center gap-2 rounded-2xl border border-border p-5">
        <QrCode
          value={`snp:${result.patientId.trim().toLowerCase()}`}
          size={180}
        />
        <p className="text-center text-sm text-muted">
          Show this QR code at the camp desk. Take a screenshot.
        </p>
      </div>

      <dl className="space-y-3 rounded-xl border border-border p-4 text-sm">
        <div>
          <dt className="text-muted">Camp Day</dt>
          <dd className="font-semibold">
            {result.dayDate
              ? formatCampDay(result.dayDate)
              : "Confirm at desk"}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Venue</dt>
          <dd className="font-semibold">
            {venue || "Confirm at desk"}
          </dd>
        </div>
      </dl>

      <p className="text-sm text-muted">
        Please visit your venue on the camp day — your prescription slip will be printed at the desk.
      </p>

      <p className="rounded-xl border border-border p-3 text-sm text-muted">
        SMS confirmation is not sent. Prescription slip will be printed at the camp desk. Please save your number and QR code.
      </p>
    </section>
  );
}
