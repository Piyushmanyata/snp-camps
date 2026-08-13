"use client";

import { Suspense } from "react";
import { Card, SectionTitle } from "@/components/ui";
import { QrScannerLazy } from "@/components/qr-scanner-lazy";

/**
 * The camp-day desk is the scanner: print prescription and mark seen.
 * There is no Live Queue panel — the hall does not run off a list (ADR 0013).
 * Client island so Server Components never pass function children.
 */
export function DeskScan({
  campId,
  noCampReason,
}: {
  campId: string | null;
  noCampReason?: string;
}) {
  return (
    <Card id="scan" className="!p-4 sm:!p-5">
      <SectionTitle hint="QR scan karein, ya number/naam likhein">
        Marij scan karein
      </SectionTitle>
      <Suspense
        fallback={
          <p role="status" className="py-6 text-center text-sm text-muted">
            Scanner load ho raha hai…
          </p>
        }
      >
        <QrScannerLazy campId={campId} disabledReason={noCampReason} />
      </Suspense>
    </Card>
  );
}
