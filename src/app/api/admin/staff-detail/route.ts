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

  // Non-admins may only see their own KPIs (not fellow staff).
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

  if (role === "doctor") {
    let totalQuery = supabase
      .from("patients")
      .select("id", { count: "exact", head: true })
      .eq("seen_by", id)
      .eq("queue_status", "seen");

    let todayQuery = supabase
      .from("patients")
      .select("id", { count: "exact", head: true })
      .eq("seen_by", id)
      .eq("queue_status", "seen")
      .gte("seen_at", startOfDay);

    let patientsQuery = supabase
      .from("patients")
      .select("id, reg_no, full_name, phone, queue_status, seen_at, created_at")
      .eq("seen_by", id)
      .eq("queue_status", "seen")
      .order("seen_at", { ascending: false })
      .limit(40);

    if (activeCamp) {
      totalQuery = totalQuery.eq("camp_id", activeCamp.id);
      todayQuery = todayQuery.eq("camp_id", activeCamp.id);
      patientsQuery = patientsQuery.eq("camp_id", activeCamp.id);
    }

    const [totalRes, todayRes, patientsRes] = await Promise.all([
      totalQuery,
      todayQuery,
      patientsQuery,
    ]);

    if (totalRes.error || todayRes.error || patientsRes.error) {
      return NextResponse.json(
        {
          error:
            totalRes.error?.message ||
            todayRes.error?.message ||
            patientsRes.error?.message ||
            "Failed to load KPIs",
        },
        { status: 400 },
      );
    }

    return NextResponse.json({
      person,
      kpis: {
        total: totalRes.count ?? 0,
        today: todayRes.count ?? 0,
        label: "Patients seen",
      },
      patients: patientsRes.data || [],
    });
  }

  let totalQuery = supabase
    .from("patients")
    .select("id", { count: "exact", head: true })
    .eq("created_by", id);

  let todayQuery = supabase
    .from("patients")
    .select("id", { count: "exact", head: true })
    .eq("created_by", id)
    .gte("created_at", startOfDay);

  let waitingQuery = supabase
    .from("patients")
    .select("id", { count: "exact", head: true })
    .eq("created_by", id)
    .eq("queue_status", "waiting");

  let seenQuery = supabase
    .from("patients")
    .select("id", { count: "exact", head: true })
    .eq("created_by", id)
    .eq("queue_status", "seen");

  let patientsQuery = supabase
    .from("patients")
    .select(
      "id, reg_no, full_name, phone, queue_status, seen_at, created_at",
    )
    .eq("created_by", id)
    .order("created_at", { ascending: false })
    .limit(40);

  if (activeCamp) {
    totalQuery = totalQuery.eq("camp_id", activeCamp.id);
    todayQuery = todayQuery.eq("camp_id", activeCamp.id);
    waitingQuery = waitingQuery.eq("camp_id", activeCamp.id);
    seenQuery = seenQuery.eq("camp_id", activeCamp.id);
    patientsQuery = patientsQuery.eq("camp_id", activeCamp.id);
  }

  const [totalRes, todayRes, waitingRes, seenRes, patientsRes] =
    await Promise.all([
      totalQuery,
      todayQuery,
      waitingQuery,
      seenQuery,
      patientsQuery,
    ]);

  const err =
    totalRes.error ||
    todayRes.error ||
    waitingRes.error ||
    seenRes.error ||
    patientsRes.error;
  if (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }

  return NextResponse.json({
    person,
    kpis: {
      total: totalRes.count ?? 0,
      today: todayRes.count ?? 0,
      waiting: waitingRes.count ?? 0,
      seen: seenRes.count ?? 0,
      label: "Patients registered",
    },
    patients: patientsRes.data || [],
  });
}
