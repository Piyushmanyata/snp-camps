import { NextResponse } from "next/server";
import { loadSessionProfile } from "@/lib/auth";
import { isCampCrew, isStaff, isTeamLead } from "@/lib/roles";
import { isPatientUuid } from "@/lib/qr";
import {
  isSectionKey,
  loadSection,
  type SectionKey,
} from "@/lib/section-reads";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/**
 * Narrow section re-read for recoverable client islands (#63).
 * One section per request — never bundles sibling desk queries.
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

  const url = new URL(request.url);
  const sectionRaw = url.searchParams.get("section")?.trim() ?? "";
  if (!isSectionKey(sectionRaw)) {
    return NextResponse.json(
      { error: "Unknown section" },
      { status: 400, headers: NO_STORE },
    );
  }
  const section: SectionKey = sectionRaw;

  // Role gates for sensitive sections
  if (section === "admin-analytics" && profile?.role !== "admin") {
    return NextResponse.json(
      { error: "Admin access required" },
      { status: 403, headers: NO_STORE },
    );
  }
  if (section === "volunteer-kpis" && !isStaff(profile?.role)) {
    return NextResponse.json(
      { error: "Staff access required" },
      { status: 403, headers: NO_STORE },
    );
  }

  const campIdRaw = url.searchParams.get("campId")?.trim() ?? "";
  const campId =
    campIdRaw && isPatientUuid(campIdRaw) ? campIdRaw : null;

  const result = await loadSection(section, {
    campId,
    userId,
    kpiRole: isTeamLead(profile?.role) ? "team_lead" : "volunteer",
  });

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: 502, headers: NO_STORE },
    );
  }

  return NextResponse.json(
    { ok: true, data: result.data },
    { headers: NO_STORE },
  );
}
