"use client";

import { Suspense, useCallback, useState } from "react";
import dynamic from "next/dynamic";
import { SectionLoadError } from "@/components/section-load-error";
import { SectionTitle } from "@/components/ui";
import { Card } from "@/components/ui";
import { fetchDeskSection } from "@/lib/section-client";
import type { DoctorOption } from "@/lib/types";
import type { LiveQueuePatient } from "@/components/live-queue";

/** Keep in sync with DOCTOR_LIST_UNAVAILABLE in metadata (client-safe copy). */
const DOCTOR_LIST_UNAVAILABLE =
  "Doctor list unavailable. Tell an admin.";

const LiveQueue = dynamic(
  () =>
    import("@/components/live-queue").then((m) => ({ default: m.LiveQueue })),
  {
    loading: () => (
      <p role="status" className="py-4 text-xs text-muted">
        Loading queue…
      </p>
    ),
  },
);

const QrScanner = dynamic(
  () =>
    import("@/components/qr-scanner").then((m) => ({ default: m.QrScanner })),
  {
    loading: () => (
      <p role="status" className="py-6 text-center text-sm text-muted">
        Loading scanner…
      </p>
    ),
  },
);

type DoctorsInitial =
  | { ok: true; data: DoctorOption[] }
  | { ok: false; error: string };

/**
 * Scanner + queue share one doctors list with isolated doctors retry (#63).
 * Client island so Server Components never pass function children.
 */
export function DeskScanQueue({
  mode,
  campId,
  doctorsInitial,
  waiting,
  waitingTotal,
  queueKnown,
  noCampReason,
}: {
  mode: "volunteer" | "admin";
  campId: string | null;
  doctorsInitial: DoctorsInitial;
  waiting: LiveQueuePatient[];
  waitingTotal: number;
  queueKnown: boolean;
  noCampReason?: string;
}) {
  const [doctors, setDoctors] = useState<DoctorOption[]>(
    doctorsInitial.ok ? doctorsInitial.data : [],
  );
  const [doctorsError, setDoctorsError] = useState<string | null>(
    doctorsInitial.ok ? null : doctorsInitial.error,
  );

  const retryDoctors = useCallback(() => {
    void (async () => {
      const result = await fetchDeskSection<DoctorOption[]>("doctors");
      if (result.ok) {
        setDoctors(result.data);
        setDoctorsError(null);
        return;
      }
      // Soft failure: keep prior doctors when present.
      if (doctors.length === 0) {
        setDoctorsError(result.error);
      }
    })();
  }, [doctors.length]);

  const scannerDisabled =
    noCampReason ||
    (doctorsError && doctors.length === 0
      ? DOCTOR_LIST_UNAVAILABLE
      : undefined);

  return (
    <div className="grid gap-3 sm:gap-4 lg:grid-cols-2 lg:items-start">
      <Card id="scan" className="!p-4 sm:!p-5">
        <SectionTitle
          hint={
            mode === "admin"
              ? "Scan QR or type reg number · review and assign"
              : "Scan paper or phone QR · pick doctor"
          }
        >
          Scan / assign doctor
        </SectionTitle>
        {doctorsError && doctors.length === 0 ? (
          <SectionLoadError
            message={doctorsError}
            onRetry={() => retryDoctors()}
          />
        ) : null}
        <Suspense
          fallback={
            <p role="status" className="py-6 text-center text-sm text-muted">
              Loading scanner…
            </p>
          }
        >
          <QrScanner
            mode={mode}
            doctors={doctors}
            disabledReason={scannerDisabled}
          />
        </Suspense>
      </Card>

      <Card padding="sm" id="queue">
        <div className="px-1 pt-1">
          <SectionTitle
            hint={mode === "admin" ? "FCFS · assign doctor · live" : "Line · live"}
          >
            Queue
          </SectionTitle>
        </div>
        <LiveQueue
          initial={waiting}
          initialTotal={waitingTotal}
          campId={campId}
          doctors={doctors}
          mode={mode}
          initialLoadKnown={queueKnown}
        />
      </Card>
    </div>
  );
}
