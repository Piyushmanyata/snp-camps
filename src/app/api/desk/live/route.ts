import { NextResponse } from "next/server";
import { loadSessionProfile } from "@/lib/auth";
import { isCampCrew } from "@/lib/roles";
import { type DeskLivePayload } from "@/lib/desk-live";
import { isPatientUuid } from "@/lib/qr";
import { createClient } from "@/lib/supabase/server";
import type { CampDayStats } from "@/lib/types";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

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

  const [{ data: campRow, error: campErr }, dayStatsRes] = await Promise.all([
    supabase.from("camps").select("id, is_active").eq("id", campId).maybeSingle(),
    supabase.rpc("camp_day_stats", { p_camp_id: campId }),
  ]);

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

  if (dayStatsRes.error) {
    return NextResponse.json(
      { error: "Desk live data could not be loaded" },
      { status: 502, headers: NO_STORE },
    );
  }

  const body: DeskLivePayload = {
    days: (dayStatsRes.data || []) as CampDayStats[],
  };

  return NextResponse.json(body, { headers: NO_STORE });
}
