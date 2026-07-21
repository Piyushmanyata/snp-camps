import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile, isAdmin, isStaff } from "@/lib/auth";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Doctor/volunteer KPIs + recent patients for staff desks and admin.
 * Doctor → patients seen_by them. Volunteer → patients they registered.
 */
export async function GET(req: Request) {
  const { userId, profile } = await getSessionProfile();
  if (!userId || !isStaff(profile?.role)) {
    return NextResponse.json({ error: "Staff only" }, { status: 403 });
  }

  const url = new URL(req.url);
  const id = (url.searchParams.get("id") || "").trim();
  const role = (url.searchParams.get("role") || "").trim();
  if (!UUID.test(id) || (role !== "doctor" && role !== "volunteer")) {
    return NextResponse.json(
      { error: "Valid id and role (doctor|volunteer) required" },
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

  const { data: activeCamp } = await supabase
    .from("camps")
    .select("id")
    .eq("is_active", true)
    .maybeSingle();

  const { data: person, error: pErr } = await supabase
    .from("profiles")
    .select("id, full_name, email, phone, role, created_at")
    .eq("id", id)
    .eq("role", role)
    .maybeSingle();

  if (pErr) {
    return NextResponse.json({ error: pErr.message }, { status: 400 });
  }
  if (!person) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const kolkataDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const startOfDay = new Date(kolkataDate + "T00:00:00+05:30").toISOString();
  const campId = activeCamp?.id ?? null;

  const { data: kpiRows, error: kpiErr } = await supabase.rpc(
    "staff_person_kpis",
    {
      p_user_id: id,
      p_role: role,
      p_camp_id: campId,
      p_since: startOfDay,
    },
  );

  if (kpiErr) {
    return NextResponse.json({ error: kpiErr.message }, { status: 400 });
  }

  const kpiRow = (Array.isArray(kpiRows) ? kpiRows[0] : kpiRows) as {
    total?: number;
    today?: number;
    waiting?: number;
    seen?: number;
    label?: string;
  } | null;

  let patientsQuery = supabase
    .from("patients")
    .select(
      "id, reg_no, full_name, phone, queue_status, seen_at, created_at",
    )
    .limit(40);

  if (role === "doctor") {
    patientsQuery = patientsQuery
      .eq("seen_by", id)
      .eq("queue_status", "seen")
      .order("seen_at", { ascending: false });
  } else {
    patientsQuery = patientsQuery
      .eq("created_by", id)
      .order("created_at", { ascending: false });
  }
  if (campId) {
    patientsQuery = patientsQuery.eq("camp_id", campId);
  }

  const { data: patients, error: patientsErr } = await patientsQuery;
  if (patientsErr) {
    return NextResponse.json({ error: patientsErr.message }, { status: 400 });
  }

  return NextResponse.json({
    person,
    kpis: {
      total: Number(kpiRow?.total ?? 0),
      today: Number(kpiRow?.today ?? 0),
      waiting: Number(kpiRow?.waiting ?? 0),
      seen: Number(kpiRow?.seen ?? 0),
      label:
        kpiRow?.label ||
        (role === "doctor" ? "Patients seen" : "Patients registered"),
    },
    patients: patients || [],
  });
}