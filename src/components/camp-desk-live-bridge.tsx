"use client";

import { useCallback, useTransition } from "react";
import { useRouter } from "next/navigation";
import { POLL_MS, useFixedPoll } from "@/lib/poll";

/**
 * KPI catch-up for staff screens without LiveQueue/SeatBoard
 * (doctor station stats + patients-seen). Poll-only ~20s while visible (#56).
 * Uses router.refresh — KPIs are not on the minimal desk-live endpoint.
 */
export function CampDeskLiveBridge({
  campId,
}: {
  campId: string | null | undefined;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const refresh = useCallback(() => {
    if (!campId) return;
    startTransition(() => {
      router.refresh();
    });
  }, [campId, router]);

  useFixedPoll(refresh, POLL_MS, Boolean(campId));

  return null;
}
