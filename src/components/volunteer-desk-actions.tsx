"use client";

import { ActionCard } from "@/components/ui";
import { DeskScan } from "@/components/desk-scan";
import { useCampDeskLive } from "@/lib/use-camp-desk-live";
import { deskPrintWindowOpen } from "@/lib/print-window";
import type { CampDayStats } from "@/lib/types";

export function VolunteerDeskActions({
  campId,
  noCampReason,
  seedDays,
  userRole = null,
}: {
  campId: string | null;
  noCampReason?: string;
  seedDays: CampDayStats[];
  userRole?: string | null;
}) {
  const live = useCampDeskLive(campId, { days: seedDays });
  const windowOpen = deskPrintWindowOpen(
    live.days.length ? live.days : seedDays,
  );

  return (
    <>
      <ActionCard
        href="/register"
        title="Register new patient"
        description={
          windowOpen
            ? "Name, phone, Aadhaar — then print prescription"
            : "Name, phone, Aadhaar. Printing is closed."
        }
        variant="primary"
        disabled={!campId}
        disabledReason="No active camp. Ask admin to activate a camp."
      />
      {windowOpen ? (
        <div data-testid="desk-print-window-open">
          <DeskScan
            campId={campId}
            noCampReason={noCampReason}
            userRole={userRole}
          />
        </div>
      ) : (
        <p
          data-testid="desk-print-window-closed"
          className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-950"
        >
          Print and Mark seen are closed. Ask admin to open print window.
        </p>
      )}
    </>
  );
}
