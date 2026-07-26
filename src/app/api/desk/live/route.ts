import { NextResponse } from "next/server";
import { loadSessionProfile } from "@/lib/auth";
import { isCampCrew, isStaff } from "@/lib/roles";
import {
  DESK_LIVE_WAITING_LIMIT,
  DESK_LIVE_WAITING_SELECT,
  type DeskLivePayload,
  type DeskLiveWaitingRow,
} from "@/lib/desk-live";
import { isPatientUuid } from "@/lib/qr";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import type { CampDayStats } from "@/lib/types";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/**
 * Minimal desk poll (#53/#56): waiting list + seat counts for one camp.
 * Role-projected: doctors never receive phone (or other PHI columns).
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
  const includePhone = isStaff(profile?.role);

  // Active-camp gate (doctors have no broad patient SELECT after #56).
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

  // Staff use the session client (RLS). Doctors use service role only for the
  // projected waiting snapshot — they must not gain table SELECT.
  let waitingRaw: DeskLiveWaitingRow[] = [];
  let waitingTotal = 0;
  let dayStats: CampDayStats[] = [];

  if (includePhone) {
    const [waitingRes, dayStatsRes] = await Promise.all([
      supabase
        .from("patients")
        .select(DESK_LIVE_WAITING_SELECT, { count: "exact" })
        .eq("camp_id", campId)
        .eq("queue_status", "waiting")
        // FCFS: queued_at, then reg_no, then id (#70)
        .order("queued_at", { ascending: true, nullsFirst: false })
        .order("reg_no", { ascending: true })
        .order("id", { ascending: true })
        .limit(DESK_LIVE_WAITING_LIMIT),
      supabase.rpc("camp_day_stats", { p_camp_id: campId }),
    ]);

    if (waitingRes.error || dayStatsRes.error) {
      return NextResponse.json(
        { error: "Desk live data could not be loaded" },
        { status: 502, headers: NO_STORE },
      );
    }

    waitingRaw = (waitingRes.data || []).map((row) => ({
      id: row.id,
      reg_no: row.reg_no,
      full_name: row.full_name,
      phone: row.phone ?? null,
    })) as DeskLiveWaitingRow[];
    waitingTotal = waitingRes.count ?? waitingRaw.length;
    dayStats = (dayStatsRes.data || []) as CampDayStats[];
  } else {
    const admin = createServiceRoleClient();
    if (!admin) {
      return NextResponse.json(
        { error: "Desk live data could not be loaded" },
        { status: 503, headers: NO_STORE },
      );
    }
    const [waitingRes, dayStatsRes] = await Promise.all([
      admin
        .from("patients")
        .select("id, reg_no, full_name, queued_at", { count: "exact" })
        .eq("camp_id", campId)
        .eq("queue_status", "waiting")
        // FCFS: queued_at, then reg_no, then id (#70)
        .order("queued_at", { ascending: true, nullsFirst: false })
        .order("reg_no", { ascending: true })
        .order("id", { ascending: true })
        .limit(DESK_LIVE_WAITING_LIMIT),
      supabase.rpc("camp_day_stats", { p_camp_id: campId }),
    ]);

    if (waitingRes.error || dayStatsRes.error) {
      return NextResponse.json(
        { error: "Desk live data could not be loaded" },
        { status: 502, headers: NO_STORE },
      );
    }

    waitingRaw = (waitingRes.data || []).map((row) => ({
      id: row.id,
      reg_no: row.reg_no,
      full_name: row.full_name,
      phone: null,
    })) as DeskLiveWaitingRow[];
    waitingTotal = waitingRes.count ?? waitingRaw.length;
    dayStats = (dayStatsRes.data || []) as CampDayStats[];
  }

  const body: DeskLivePayload = {
    waiting: waitingRaw,
    waitingTotal,
    days: dayStats,
  };

  return NextResponse.json(body, { headers: NO_STORE });
}
