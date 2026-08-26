"use client";

import { Suspense } from "react";
import { Card, SectionTitle } from "@/components/ui";
import { QrScannerLazy } from "@/components/qr-scanner-lazy";

export function DeskScan({
  campId,
  noCampReason,
  userRole = null,
}: {
  campId: string | null;
  noCampReason?: string;
  userRole?: string | null;
}) {
  return (
    <Card id="scan" className="!p-4 sm:!p-5">
      <SectionTitle hint="Scan QR code or type number/name">
        Scan patient
      </SectionTitle>
      <Suspense
        fallback={
          <p role="status" className="py-6 text-center text-sm text-muted">
            Loading scanner…
          </p>
        }
      >
        <QrScannerLazy
          campId={campId}
          disabledReason={noCampReason}
          userRole={userRole}
        />
      </Suspense>
    </Card>
  );
}
