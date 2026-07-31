import { NextResponse } from "next/server";
import { loadSessionProfile } from "@/lib/auth";
import { isCampCrew } from "@/lib/roles";
import {
  DESK_LIVE_WAITING_LIMIT,
  DESK_LIVE_WAITING_SELECT,
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

  // Avoid exact COUNT when under the display limit: fetch limit+1 and infer.
  const fetchLimit = DESK_LIVE_WAITING_LIMIT + 1;
  const [waitingRes, dayStatsRes] = await Promise.all([
    supabase
      .from("patients")
      .select(DESK_LIVE_WAITING_SELECT)
      .eq("camp_id", campId)
      .eq("queue_status", "waiting")
      // FCFS: queued_at, then reg_no, then id (#70)
      .order("queued_at", { ascending: true, nullsFirst: false })
      .order("reg_no", { ascending: true })
      .order("id", { ascending: true })
      .limit(fetchLimit),
    supabase.rpc("camp_day_stats", { p_camp_id: campId }),
  ]);

  if (waitingRes.error || dayStatsRes.error) {
    return NextResponse.json(
      { error: "Desk live data could not be loaded" },
      { status: 502, headers: NO_STORE },
    );
  }

  const waitingRows = waitingRes.data || [];
  const overLimit = waitingRows.length > DESK_LIVE_WAITING_LIMIT;
  const waitingSlice = overLimit
    ? waitingRows.slice(0, DESK_LIVE_WAITING_LIMIT)
    : waitingRows;

  // Only pay for exact count when the queue exceeds the display window.
  let waitingTotal = waitingSlice.length;
  if (overLimit) {
    const { count, error: countError } = await supabase
      .from("patients")
      .select("id", { count: "exact", head: true })
      .eq("camp_id", campId)
      .eq("queue_status", "waiting");
    if (countError) {
      return NextResponse.json(
        { error: "Desk live data could not be loaded" },
        { status: 502, headers: NO_STORE },
      );
    }
    waitingTotal = count ?? waitingSlice.length;
  }

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
