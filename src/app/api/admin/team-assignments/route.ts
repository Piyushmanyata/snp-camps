import { NextResponse } from "next/server";
import { loadSessionProfile, readJsonBody } from "@/lib/auth";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { mapDbError } from "@/lib/public-error";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function PATCH(request: Request) {
  const { userId, profile } = await loadSessionProfile();
  if (!userId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const body = await readJsonBody<{
    volunteerId?: unknown;
    teamLeadId?: unknown;
  }>(request);
  const volunteerId =
    typeof body?.volunteerId === "string" ? body.volunteerId.trim() : "";
  const rawLead = body?.teamLeadId;
  const teamLeadId =
    rawLead === null
      ? null
      : typeof rawLead === "string"
        ? rawLead.trim() || null
        : undefined;

  if (!UUID.test(volunteerId) || teamLeadId === undefined) {
    return NextResponse.json(
      { error: "Valid volunteer and Team Lead selection required" },
      { status: 400 },
    );
  }
  if (teamLeadId !== null && !UUID.test(teamLeadId)) {
    return NextResponse.json({ error: "Valid Team Lead required" }, { status: 400 });
  }

  const admin = createServiceRoleClient();
  if (!admin) {
    return NextResponse.json(
      { error: "Account service is unavailable" },
      { status: 503 },
    );
  }

  const { data, error } = await admin
    .from("profiles")
    .update({ team_lead_id: teamLeadId })
    .eq("id", volunteerId)
    .eq("role", "volunteer")
    .select("id, team_lead_id")
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      {
        error: mapDbError(error, {
          context: "admin-team-assignment.update",
          fallback: "Team assignment could not be saved. Refresh and retry.",
        }),
      },
      { status: 409 },
    );
  }
  if (!data) {
    return NextResponse.json({ error: "Volunteer not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, assignment: data });
}
