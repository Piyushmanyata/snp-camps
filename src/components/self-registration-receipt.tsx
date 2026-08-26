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
        {result.existing ? "Pehle se register hain" : "Registration ho gaya"}
      </h2>
      <p className="rounded-2xl bg-brand-soft p-6 text-center">
        <span className="block text-xs font-bold uppercase text-brand">
          {result.existing ? "Aapka registration number" : "Registration number"}
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
          Yeh QR camp desk par dikhayein. Screenshot le lein.
        </p>
      </div>

      <dl className="space-y-3 rounded-xl border border-border p-4 text-sm">
        <div>
          <dt className="text-muted">Camp Day</dt>
          <dd className="font-semibold">
            {result.dayDate
              ? formatCampDay(result.dayDate)
              : "Desk par confirm karein"}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Venue</dt>
          <dd className="font-semibold">
            {venue || "Desk par confirm karein"}
          </dd>
        </div>
      </dl>

      <p className="text-sm text-muted">
        Camp ke din apne venue par jaayein — desk par aapki parchi print hogi.
      </p>

      <p className="rounded-xl border border-border p-3 text-sm text-muted">
        SMS nahi aayega. Camp din parchi desk par print hogi. Number aur QR
        save kar lein.
      </p>
    </section>
  );
}
