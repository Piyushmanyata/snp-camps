import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { loadSessionProfile, isAdmin, isCampCrew } from "@/lib/auth";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function GET(req: Request) {
  const { userId, profile } = await loadSessionProfile();
  if (!userId || !isCampCrew(profile?.role)) {
    return NextResponse.json({ error: "Camp crew only" }, { status: 403 });
  }

  const url = new URL(req.url);
  const id = (url.searchParams.get("id") || "").trim();
  const role = (url.searchParams.get("role") || "").trim();
  if (!UUID.test(id) || (role !== "volunteer" && role !== "team_lead")) {
    return NextResponse.json(
      { error: "Valid id and role (volunteer|team_lead) required" },
      { status: 400 },
    );
  }

  if (!isAdmin(profile?.role) && id !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!isAdmin(profile?.role) && profile?.role !== role) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const supabase = await createClient();

  const [
    { data: activeCamp, error: campError },
    { data: person, error: pErr },
  ] =
    await Promise.all([
      supabase
        .from("camps")
        .select("id")
        .eq("is_active", true)
        .maybeSingle(),
      supabase
        .from("profiles")
        .select("id, full_name, email, phone, role, created_at")
        .eq("id", id)
        .eq("role", role)
        .maybeSingle(),
    ]);

  if (campError || pErr) {
    return NextResponse.json(
      { error: "Staff details could not be loaded" },
      { status: 500 },
    );
  }
  if (!person) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const campId = activeCamp?.id ?? null;

  const [
    { data: kpiRows, error: kpiErr },
    { data: patients, error: patientsErr },
  ] = await Promise.all([
    supabase.rpc("staff_person_kpis", {
      p_user_id: id,
      p_role: role,
      p_camp_id: campId,
      p_scope: "person",
    }),
    supabase.rpc("staff_registered_patients", {
      p_staff_id: id,
      p_limit: 50,
    }),
  ]);

  if (kpiErr) {
    return NextResponse.json(
      { error: "Staff statistics could not be loaded" },
      { status: 502 },
    );
  }

  if (patientsErr) {
    return NextResponse.json(
      { error: "Registered patients could not be loaded" },
      { status: 502 },
    );
  }

  const kpiRow = (Array.isArray(kpiRows) ? kpiRows[0] : kpiRows) as {
    total?: number;
    seen?: number;
  } | null;

  return NextResponse.json({
    person,
    kpis: {
      total: Number(kpiRow?.total ?? 0),
      seen: Number(kpiRow?.seen ?? 0),
    },
    patients: patients || [],
  });
}
