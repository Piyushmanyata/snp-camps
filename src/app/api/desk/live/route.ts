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
 * Minimal desk poll (#53): waiting list + seat counts for one camp.
 * Intentionally omits doctor list and KPI RPCs — those stay on full page load.
 * Staff Realtime (#25/#26) remains primary; this powers reconnect poll + catch-up.
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
    // UUID shape check — camp ids are UUIDs (reuse patient UUID validator).
    return NextResponse.json(
      { error: "campId required" },
      { status: 400, headers: NO_STORE },
    );
  }

  const supabase = await createClient();
  const [waitingRes, dayStatsRes] = await Promise.all([
    supabase
      .from("patients")
      .select(DESK_LIVE_WAITING_SELECT, { count: "exact" })
      .eq("camp_id", campId)
      .eq("queue_status", "waiting")
      .order("queued_at", { ascending: true, nullsFirst: false })
      .limit(DESK_LIVE_WAITING_LIMIT),
    supabase.rpc("camp_day_stats", { p_camp_id: campId }),
  ]);

  if (waitingRes.error || dayStatsRes.error) {
    return NextResponse.json(
      { error: "Desk live data could not be loaded" },
      { status: 502, headers: NO_STORE },
    );
  }

  const waiting = (waitingRes.data || []).map((row) => ({
    id: row.id,
    reg_no: row.reg_no,
    full_name: row.full_name,
    phone: row.phone ?? null,
  })) as DeskLiveWaitingRow[];

  const body: DeskLivePayload = {
    waiting,
    waitingTotal: waitingRes.count ?? waiting.length,
    days: (dayStatsRes.data || []) as CampDayStats[],
  };

  return NextResponse.json(body, { headers: NO_STORE });
}
