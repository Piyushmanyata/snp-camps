"use client";

import { useEffect, useState } from "react";
import {
  refreshCampDeskLive,
  subscribeCampDeskLive,
  type DeskLiveFreshness,
  type DeskLiveSeed,
  type DeskLiveView,
} from "@/lib/camp-desk-live";
import type { CampDayStats } from "@/lib/types";

export type { DeskLiveFreshness };

function initialView(
  campId: string | null | undefined,
  seed?: DeskLiveSeed,
): DeskLiveView {
  if (!campId) {
    return {
      campId: null,
      days: [],
      freshness: "off",
      daysKnown: false,
      generation: 0,
    };
  }
  const daysKnown =
    seed?.daysKnown === true ||
    (seed?.daysKnown !== false && Array.isArray(seed?.days));
  return {
    campId,
    days: seed?.days ? [...seed.days] : [],
    freshness: daysKnown ? "fresh" : "refreshing",
    daysKnown,
    generation: 0,
  };
}

/**
 * Shared camp-keyed desk snapshot (#56). Multiple components for the same
 * campId share one poller; no websocket channels.
 */
export function useCampDeskLive(
  campId: string | null | undefined,
  seed?: DeskLiveSeed,
): {
  days: CampDayStats[];
  freshness: DeskLiveFreshness;
  daysKnown: boolean;
  generation: number;
  refreshing: boolean;
  stale: boolean;
  failed: boolean;
  refresh: () => void;
} {
  const [view, setView] = useState<DeskLiveView>(() =>
    initialView(campId, seed),
  );

  useEffect(() => {
    if (!campId) {
      return;
    }
    return subscribeCampDeskLive(campId, setView, seed);
    // Seed is only for first owner creation; re-subscribe only on camp change.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: campId only
  }, [campId]);

  // When campId becomes null, derive off state without an effect setState.
  const activeView =
    campId && view.campId === campId
      ? view
      : campId
        ? initialView(campId, seed)
        : initialView(null);

  return {
    days: activeView.days,
    freshness: activeView.freshness,
    daysKnown: activeView.daysKnown,
    generation: activeView.generation,
    refreshing: activeView.freshness === "refreshing",
    stale: activeView.freshness === "stale-error",
    failed: activeView.freshness === "error",
    refresh: () => {
      if (campId) refreshCampDeskLive(campId);
    },
  };
}
