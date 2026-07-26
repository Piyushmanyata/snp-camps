/**
 * Minimal desk live payload (#53) — waiting queue + seat board only.
 * Does not include doctor list or staff KPIs (those stay on full page load).
 */

import type { CampDayStats } from "@/lib/types";

export type DeskLiveWaitingRow = {
  id: string;
  reg_no: number;
  full_name: string;
  phone: string | null;
};

export type DeskLivePayload = {
  waiting: DeskLiveWaitingRow[];
  waitingTotal: number;
  days: CampDayStats[];
};

/** Columns returned for each waiting patient — keep the poll response small. */
export const DESK_LIVE_WAITING_SELECT =
  "id, reg_no, full_name, phone, queued_at" as const;

export const DESK_LIVE_WAITING_LIMIT = 100;

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

/** Measure JSON byte size of a realistic ~100-waiting payload (closing evidence). */
export function measureDeskLivePayloadBytes(
  payload: DeskLivePayload,
): number {
  return new TextEncoder().encode(JSON.stringify(payload)).length;
}

/** Synthetic 100-waiting payload for size assertions (no network). */
export function sampleDeskLivePayload100(
  options: { includePhone?: boolean } = {},
): DeskLivePayload {
  const includePhone = options.includePhone !== false;
  const waiting: DeskLiveWaitingRow[] = [];
  for (let i = 0; i < DESK_LIVE_WAITING_LIMIT; i++) {
    waiting.push({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      reg_no: 1000 + i,
      full_name: "Patient Name Example",
      phone: includePhone ? "+919876543210" : null,
    });
  }
  return {
    waiting,
    waitingTotal: DESK_LIVE_WAITING_LIMIT,
    days: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        camp_id: "22222222-2222-4222-8222-222222222222",
        day_date: "2026-07-27",
        seat_limit: 200,
        seats_taken: 100,
        seats_left: 100,
        is_full: false,
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        camp_id: "22222222-2222-4222-8222-222222222222",
        day_date: "2026-07-28",
        seat_limit: 150,
        seats_taken: 40,
        seats_left: 110,
        is_full: false,
      },
    ],
  };
}
