
import type { CampDayStats } from "@/lib/types";

export type DeskLivePayload = {
  days: CampDayStats[];
};

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
