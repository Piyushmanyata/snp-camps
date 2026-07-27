import { NextResponse } from "next/server";
import { getSessionProfile } from "@/lib/auth";
import { generateStaffPassword } from "@/lib/patient-password";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { mapDbError } from "@/lib/public-error";

/**
 * Create a volunteer on a team lead's team.
 *
 * The volunteer needs a Supabase Auth user to ever sign in, and Postgres cannot
 * mint one — so this mirrors the admin staff route (Auth admin API, then the
 * profile row) rather than calling `team_lead_create_volunteer`, which only ever
 * wrote an orphan profile with a random id and silently ignored its password
 * argument.
 */
export async function POST(request: Request) {
  let body: { email?: unknown; fullName?: unknown; teamLeadId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const { userId, profile } = await getSessionProfile();
  if (!userId || !profile) {
    return NextResponse.json({ ok: false, error: "Not signed in" }, { status: 401 });
  }
  if (profile.role !== "admin" && profile.role !== "team_lead") {
    return NextResponse.json(
      { ok: false, error: "Only team leads and admins can create volunteers" },
      { status: 403 },
    );
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
  if (!email || !fullName) {
    return NextResponse.json(
      { ok: false, error: "Email and Full Name required" },
      { status: 400 },
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ ok: false, error: "Invalid email" }, { status: 400 });
  }

  // A team lead may only ever staff their own team; only an admin may target
  // another lead (or leave the volunteer unassigned).
  const requestedLead =
    typeof body.teamLeadId === "string" && body.teamLeadId.trim()
      ? body.teamLeadId.trim()
      : null;
  const teamLeadId = profile.role === "team_lead" ? userId : requestedLead;

  const admin = createServiceRoleClient();
  if (!admin) {
    return NextResponse.json(
      { ok: false, error: "Account service is unavailable" },
      { status: 500 },
    );
  }

  const password = generateStaffPassword();
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });

  if (createErr || !created?.user) {
    const msg = createErr?.message.toLowerCase() ?? "";
    return NextResponse.json(
      {
        ok: false,
        error: msg.includes("already")
          ? "That email is already registered. Share their existing login or use a different email."
          : mapDbError(createErr, {
              context: "team-lead.create-volunteer",
              fallback: "Volunteer account could not be created. Try again.",
            }),
      },
      { status: 400 },
    );
  }

  const { error: profileErr } = await admin.from("profiles").upsert({
    id: created.user.id,
    role: "volunteer",
    full_name: fullName,
    email,
    team_lead_id: teamLeadId,
  });

  if (profileErr) {
    await admin.auth.admin.deleteUser(created.user.id);
    return NextResponse.json(
      { ok: false, error: "Volunteer could not be provisioned. Try again." },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      temporaryPassword: password,
      volunteer: {
        id: created.user.id,
        full_name: fullName,
        email,
        team_lead_id: teamLeadId,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
