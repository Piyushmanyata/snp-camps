import { NextResponse } from "next/server";
import { loadSessionProfile } from "@/lib/auth";
import { isCampCrew } from "@/lib/roles";
import {
  DESK_LIVE_WAITING_LIMIT,
  type DeskLivePayload,
  type DeskLiveWaitingRow,
} from "@/lib/desk-live";
import { isPatientUuid } from "@/lib/qr";
import { createClient } from "@/lib/supabase/server";
import type { CampDayStats } from "@/lib/types";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/**
 * Minimal desk poll (#53/#56): waiting list + seat counts for one camp.
 * Poll is the sole freshness owner — no Realtime.
 */
export async function GET(request: Request) {
  const { userId, profile } = await loadSessionProfile();
  if (!userId) {
    return NextResponse.json(
      { error: "Not signed in" },
      { status: 401, headers: NO_STORE },
    );
  }
  if (!isCampCrew(profile?.role)) {
    return NextResponse.json(
      { error: "Camp crew only" },
      { status: 403, headers: NO_STORE },
    );
  }

  const campId = new URL(request.url).searchParams.get("campId")?.trim() ?? "";
  if (!campId || !isPatientUuid(campId)) {
    return NextResponse.json(
      { error: "campId required" },
      { status: 400, headers: NO_STORE },
    );
  }

  const supabase = await createClient();

  // Active-camp gate keeps the polling surface scoped to live operations.
  const { data: campRow, error: campErr } = await supabase
    .from("camps")
    .select("id, is_active")
    .eq("id", campId)
    .maybeSingle();

  if (campErr || !campRow) {
    return NextResponse.json(
      { error: "Camp not found" },
      { status: 404, headers: NO_STORE },
    );
  }
  if (!campRow.is_active) {
    return NextResponse.json(
      { error: "Inactive camp" },
      { status: 403, headers: NO_STORE },
    );
  }

  const [waitingRes, dayStatsRes] = await Promise.all([
    supabase.rpc("desk_waiting_queue", {
      p_camp_id: campId,
      p_limit: DESK_LIVE_WAITING_LIMIT + 1,
    }),
    supabase.rpc("camp_day_stats", { p_camp_id: campId }),
  ]);

  if (waitingRes.error || dayStatsRes.error) {
    return NextResponse.json(
      { error: "Desk live data could not be loaded" },
      { status: 502, headers: NO_STORE },
    );
  }

  const waitingRows = (waitingRes.data || []) as Array<{
    id: string;
    reg_no: number;
    full_name: string;
    phone: string | null;
    waiting_total: number;
  }>;
  const overLimit = waitingRows.length > DESK_LIVE_WAITING_LIMIT;
  const waitingSlice = overLimit
    ? waitingRows.slice(0, DESK_LIVE_WAITING_LIMIT)
    : waitingRows;

  const waitingTotal = Number(
    (waitingRows[0] as { waiting_total?: number } | undefined)?.waiting_total ??
      waitingRows.length,
  );

  const waitingRaw = waitingSlice.map((row) => ({
    id: row.id,
    reg_no: row.reg_no,
    full_name: row.full_name,
    phone: row.phone ?? null,
  })) as DeskLiveWaitingRow[];
  const dayStats = (dayStatsRes.data || []) as CampDayStats[];

  const body: DeskLivePayload = {
    waiting: waitingRaw,
    waitingTotal,
    days: dayStats,
  };

  return NextResponse.json(body, { headers: NO_STORE });
}
