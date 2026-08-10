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
}: {
  campId: string | null;
  waiting: LiveQueuePatient[];
  waitingTotal: number;
  queueKnown: boolean;
  noCampReason?: string;
}) {
  return (
    <div className="grid gap-3 sm:gap-4 lg:grid-cols-2 lg:items-start">
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

      <Card padding="sm" id="queue">
        <div className="px-1 pt-1">
          <SectionTitle hint="Pehle aao, pehle pao · live">
            Line (queue)
          </SectionTitle>
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
