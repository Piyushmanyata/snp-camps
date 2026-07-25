"use client";

import { useCallback, useTransition } from "react";
import { useRouter } from "next/navigation";
import { POLL_MS, useFixedPoll } from "@/lib/poll";
import { useCampDeskRealtime } from "@/lib/use-camp-desk-realtime";
import { ReconnectingIndicator } from "@/components/reconnecting-indicator";

/**
 * Realtime catch-up for staff screens that have no LiveQueue/SeatBoard
 * (doctor station stats + patients-seen). Same reconnect + poll fallback.
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

  const liveStatus = useCampDeskRealtime(campId, refresh, Boolean(campId));
  const reconnecting = liveStatus === "reconnecting";

  useFixedPoll(refresh, POLL_MS, reconnecting);

  return <ReconnectingIndicator show={reconnecting} />;
}
