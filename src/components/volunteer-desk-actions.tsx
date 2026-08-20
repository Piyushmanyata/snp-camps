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
        title="Naya marij register karein"
        description={
          windowOpen
            ? "Naam, phone, Aadhaar — phir parchi print"
            : "Naam, phone, Aadhaar. Print band hai."
        }
        variant="primary"
        disabled={!campId}
        disabledReason="Koi active camp nahi. Admin se camp chalu karwayein."
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
          lang="hi-Latn"
          className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-950"
        >
          Print aur Mark seen band hain. Admin se print window khulwaein.
        </p>
      )}
    </>
  );
}
