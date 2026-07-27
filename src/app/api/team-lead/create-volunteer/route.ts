import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  let body: { email?: unknown; fullName?: unknown; teamLeadId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
  const teamLeadId = typeof body.teamLeadId === "string" ? body.teamLeadId.trim() : null;

  if (!email || !fullName) {
    return NextResponse.json({ ok: false, error: "Email and Full Name required" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("team_lead_create_volunteer", {
    p_email: email,
    p_password: "TempPassword123!",
    p_full_name: fullName,
    p_team_lead_id: teamLeadId,
  });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, data });
}
