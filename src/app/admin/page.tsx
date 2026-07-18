import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import type { CampDayStats } from "@/lib/types";
import { Card, NavLink, Shell, Stat, StepList } from "@/components/ui";
import { SignOutButton } from "@/components/sign-out";
import { AdminCamps } from "@/components/admin-camps";
import { AdminCampDays } from "@/components/admin-camp-days";
import { AdminPatients } from "@/components/admin-patients";
import { AdminVolunteers } from "@/components/admin-volunteers";
import { AdminDoctors } from "@/components/admin-doctors";
import { SeatBoard } from "@/components/seat-board";

export default async function AdminPage() {
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") redirect("/login");

  const supabase = await createClient();

  const { data: camps, error: campError } = await supabase
    .from("camps")
    .select("id, name, venue, camp_date, is_active, created_at")
    .order("created_at", { ascending: false });

  const active = camps?.find((c) => c.is_active);

  const [
    dayStatsRes,
    patientsRes,
    queueCountsRes,
    volunteersRes,
    doctorsRes,
  ] =
    await Promise.all([
      active
        ? supabase.rpc("camp_day_stats", { p_camp_id: active.id })
        : Promise.resolve({ data: [] as CampDayStats[] }),
      supabase
        .from("patients")
        .select(
          "id, reg_no, full_name, phone, queue_status, gender, age, created_at, camp_id, camp_day_id, camps(name), camp_days(day_date)",
          { count: "exact" },
        )
        .order("created_at", { ascending: false })
        .limit(50),
      active
        ? supabase.rpc("camp_queue_counts", { p_camp_id: active.id })
        : Promise.resolve({ data: [] }),
      supabase
        .from("profiles")
        .select("id, full_name, email, phone, role, created_at")
        .eq("role", "volunteer")
        .order("created_at", { ascending: false }),
      supabase
        .from("profiles")
        .select("id, full_name, email, phone, role, created_at")
        .eq("role", "doctor")
        .order("created_at", { ascending: false }),
    ]);

  const dataQueries = [
    patientsRes,
    queueCountsRes,
    volunteersRes,
    doctorsRes,
  ];
  if (
    Boolean(campError) ||
    dataQueries.some((result) => "error" in result && Boolean(result.error)) ||
    (active && "error" in dayStatsRes && Boolean(dayStatsRes.error))
  ) {
    throw new Error("Admin data could not be loaded");
  }

  const days = (dayStatsRes.data as CampDayStats[]) || [];

  const patients = (patientsRes.data || []).map((p) => {
    const campRel = p.camps as { name: string } | { name: string }[] | null;
    const campName = Array.isArray(campRel)
      ? campRel[0]?.name ?? null
      : campRel?.name ?? null;
    const dayRel = p.camp_days as
      | { day_date: string }
      | { day_date: string }[]
      | null;
    const dayDate = Array.isArray(dayRel)
      ? dayRel[0]?.day_date ?? null
      : dayRel?.day_date ?? null;
    return {
      id: p.id as string,
      reg_no: p.reg_no as number,
      full_name: p.full_name as string,
      phone: (p.phone as string | null) ?? null,
      queue_status: p.queue_status as string,
      gender: (p.gender as string | null) ?? null,
      age: (p.age as number | null) ?? null,
      created_at: p.created_at as string,
      camp_id: p.camp_id as string,
      camps: campName ? { name: campName } : null,
      day_date: dayDate,
    };
  });

  const queueCounts = Array.isArray(queueCountsRes.data)
    ? queueCountsRes.data[0]
    : queueCountsRes.data;
  const notQueued = Number(queueCounts?.registered_count ?? 0);
  const waiting = Number(queueCounts?.waiting_count ?? 0);
  const seen = Number(queueCounts?.seen_count ?? 0);

  const volunteers = volunteersRes.data || [];
  const doctors = doctorsRes.data || [];

  return (
    <Shell
      title="Admin"
      subtitle={profile?.full_name || "Camp control"}
      backHref="/"
      width="xl"
      roleLabel="Admin"
      dock={[
        { href: "/register", label: "Register", primary: true },
        { href: "/volunteer", label: "Volunteer" },
        { href: "/doctor", label: "Doctor" },
      ]}
    >
      <div className="space-y-5 lg:space-y-6">
        <div className="grid max-w-xl grid-cols-3 gap-2.5 sm:gap-3">
          <Stat label="Not printed" value={notQueued} />
          <Stat label="In queue" value={waiting} tone="wait" />
          <Stat label="Seen" value={seen} tone="ok" />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="bg-gradient-to-br from-brand-soft/80 to-card">
            <p className="text-xs font-bold uppercase tracking-wide text-brand">
              Active camp
            </p>
            <p className="mt-0.5 text-xl font-bold tracking-tight sm:text-2xl">
              {active?.name || "None set"}
            </p>
            {active?.venue ? (
              <p className="text-[0.9375rem] text-muted">{active.venue}</p>
            ) : null}
            <p className="mt-2 text-[0.8125rem] text-muted">
              {volunteers.length} volunteer
              {volunteers.length === 1 ? "" : "s"} · {doctors.length} doctor
              {doctors.length === 1 ? "" : "s"} · {patientsRes.count ?? patients.length} patient
              {(patientsRes.count ?? patients.length) === 1 ? "" : "s"} total
            </p>
            <div className="desk-inline-actions mt-4 gap-2.5 sm:grid-cols-2">
              <NavLink href="/register" variant="primary">
                Register patient
              </NavLink>
              <NavLink href="/volunteer" variant="soft">
                Open volunteer desk
              </NavLink>
              <NavLink href="/doctor" variant="soft">
                Open doctor desk
              </NavLink>
            </div>
          </Card>

          {active ? <SeatBoard days={days} title="Live seat board" /> : null}
        </div>

        <Card padding="sm" className="bg-background/50">
          <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-muted">
            Desk flow
          </p>
          <StepList
            steps={[
              { title: "Register", detail: "One patient, one day" },
              { title: "Print", detail: "Joins live queue" },
              { title: "Scan", detail: "Doctor marks seen" },
            ]}
          />
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          {active ? (
            <AdminCampDays
              campId={active.id}
              campName={active.name}
              initialDays={days}
            />
          ) : null}
          <AdminCamps camps={camps || []} />
        </div>

        <AdminPatients initial={patients} totalCount={patientsRes.count ?? patients.length} />
        <div className="grid gap-4 lg:grid-cols-2">
          <AdminVolunteers initial={volunteers} />
          <AdminDoctors initial={doctors} />
        </div>

        <SignOutButton />
      </div>
    </Shell>
  );
}
