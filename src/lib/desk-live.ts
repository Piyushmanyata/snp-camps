/**
 * Minimal desk live payload (#53) — seat board only.
 * There is no queue to poll (ADR 0013), and staff KPIs stay on full page load.
 */

import type { CampDayStats } from "@/lib/types";

export type DeskLivePayload = {
  days: CampDayStats[];
};

/** Client fetch of the minimal desk endpoint. */
export async function fetchDeskLive(
  campId: string,
  options: { signal?: AbortSignal } = {},
): Promise<DeskLivePayload> {
  const url = `/api/desk/live?campId=${encodeURIComponent(campId)}`;
  const res = await fetch(url, {
    cache: "no-store",
    signal: options.signal,
  });
  if (!res.ok) {
    throw new Error(`desk live ${res.status}`);
  }
  return (await res.json()) as DeskLivePayload;
}
