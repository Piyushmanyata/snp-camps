"use client";

import { Suspense } from "react";
import { SectionTitle } from "@/components/ui";
import { Card } from "@/components/ui";
import { LiveQueue, type LiveQueuePatient } from "@/components/live-queue";
import { QrScannerLazy } from "@/components/qr-scanner-lazy";

/**
 * Scanner + queue, the two halves of the camp-day desk (D23).
 * Client island so Server Components never pass function children.
 */
export function DeskScanQueue({
  campId,
  waiting,
  waitingTotal,
  queueKnown,
  noCampReason,
  scanTitle = "Scan patient",
  scanHint = "Scan a QR, or enter a registration number or name",
  queueTitle = "Queue",
  queueHint = "Arrival order · live",
}: {
  campId: string | null;
  waiting: LiveQueuePatient[];
  waitingTotal: number;
  queueKnown: boolean;
  noCampReason?: string;
  scanTitle?: string;
  scanHint?: string;
  queueTitle?: string;
  queueHint?: string;
}) {
  return (
    <div className="grid gap-3 sm:gap-4 lg:grid-cols-2 lg:items-start">
      <Card id="scan" className="!p-4 sm:!p-5">
        <SectionTitle hint={scanHint}>{scanTitle}</SectionTitle>
        <Suspense
          fallback={
            <p role="status" className="py-6 text-center text-sm text-muted">
              Loading scanner…
            </p>
          }
        >
          <QrScannerLazy campId={campId} disabledReason={noCampReason} />
        </Suspense>
      </Card>

      <Card padding="sm" id="queue">
        <div className="px-1 pt-1">
          <SectionTitle hint={queueHint}>{queueTitle}</SectionTitle>
        </div>
        <LiveQueue
          initial={waiting}
          initialTotal={waitingTotal}
          campId={campId}
          initialLoadKnown={queueKnown}
        />
      </Card>
    </div>
  );
}
