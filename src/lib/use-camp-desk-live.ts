"use client";

import { useEffect, useState } from "react";
import {
  clearDeskLivePendingRemoval,
  markDeskLivePendingRemoval,
  refreshCampDeskLive,
  subscribeCampDeskLive,
  type DeskLiveFreshness,
  type DeskLiveSeed,
  type DeskLiveView,
} from "@/lib/camp-desk-live";
import type { DeskLiveWaitingRow } from "@/lib/desk-live";
import type { CampDayStats } from "@/lib/types";

export type { DeskLiveFreshness };

function initialView(
  campId: string | null | undefined,
  seed?: DeskLiveSeed,
): DeskLiveView {
  if (!campId) {
    return {
      campId: null,
      waiting: [],
      waitingTotal: 0,
      days: [],
      freshness: "off",
      waitingKnown: false,
      daysKnown: false,
      generation: 0,
      pendingRemovals: new Set(),
    };
  }
  const waitingKnown =
    seed?.waitingKnown === true ||
    (seed?.waitingKnown !== false && Array.isArray(seed?.waiting));
  const daysKnown =
    seed?.daysKnown === true ||
    (seed?.daysKnown !== false && Array.isArray(seed?.days));
  return {
    campId,
    waiting: seed?.waiting ? [...seed.waiting] : [],
    waitingTotal: seed?.waitingTotal ?? seed?.waiting?.length ?? 0,
    days: seed?.days ? [...seed.days] : [],
    freshness: waitingKnown || daysKnown ? "fresh" : "refreshing",
    waitingKnown,
    daysKnown,
    generation: 0,
    pendingRemovals: new Set(),
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
  waiting: DeskLiveWaitingRow[];
  waitingTotal: number;
  days: CampDayStats[];
  freshness: DeskLiveFreshness;
  waitingKnown: boolean;
  daysKnown: boolean;
  generation: number;
  refreshing: boolean;
  stale: boolean;
  failed: boolean;
  refresh: () => void;
  markRemoved: (patientId: string) => void;
  clearRemoved: (patientId: string) => void;
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
    waiting: activeView.waiting,
    waitingTotal: activeView.waitingTotal,
    days: activeView.days,
    freshness: activeView.freshness,
    waitingKnown: activeView.waitingKnown,
    daysKnown: activeView.daysKnown,
    generation: activeView.generation,
    refreshing: activeView.freshness === "refreshing",
    stale: activeView.freshness === "stale-error",
    failed: activeView.freshness === "error",
    refresh: () => {
      if (campId) refreshCampDeskLive(campId);
    },
    markRemoved: (patientId: string) => {
      if (campId) markDeskLivePendingRemoval(campId, patientId);
    },
    clearRemoved: (patientId: string) => {
      if (campId) clearDeskLivePendingRemoval(campId, patientId);
    },
  };
}
