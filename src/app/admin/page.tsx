import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import type { CampDayStats } from "@/lib/types";
import { Card, NavLink, Shell, Stat } from "@/components/ui";
import { SignOutButton } from "@/components/sign-out";
import { AdminCamps } from "@/components/admin-camps";
import { AdminCampDays } from "@/components/admin-camp-days";
import { AdminPatients } from "@/components/admin-patients";
import { AdminVolunteers } from "@/components/admin-volunteers";
import { SeatBoard } from "@/components/seat-board";

export default async function AdminPage() {
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") redirect("/login");

  const supabase = await createClient();
  const { data: camps } = await supabase
    .from("camps")
    .select("*")
    .order("created_at", { ascending: false });

  const active = camps?.find((c) => c.is_active);

  const { data: dayStats } = active
    ? await supabase.rpc("camp_day_stats", { p_camp_id: active.id })
    : { data: [] };
  const days = (dayStats as CampDayStats[]) || [];

  const { data: allPatients } = await supabase
    .from("patients")
    .select(
      "id, reg_no, full_name, phone, queue_status, gender, age, created_at, camp_id, camp_day_id, camps(name), camp_days(day_date)",
    )
    .order("created_at", { ascending: false })
    .limit(500);

  const patients = (allPatients || []).map((p) => {
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

  const activePatients = active
    ? patients.filter((p) => p.camp_id === active.id)
    : patients;
  const notQueued = activePatients.filter(
    (p) => p.queue_status === "registered" || !p.queue_status,
  ).length;
  const waiting = activePatients.filter((p) => p.queue_status === "waiting")
    .length;
  const seen = activePatients.filter((p) => p.queue_status === "seen").length;

  const { data: volunteers } = await supabase
    .from("profiles")
    .select("id, full_name, email, phone, role, created_at")
    .eq("role", "volunteer")
    .order("created_at", { ascending: false });

  return (
    <Shell
      title="Admin"
      subtitle={profile?.full_name || "Camp control"}
      backHref="/"
      width="xl"
    >
      <div className="space-y-4 lg:space-y-6">
        <div className="grid grid-cols-3 gap-2.5 sm:gap-3 lg:max-w-xl">
          <Stat label="Not queued" value={notQueued} />
          <Stat label="In queue" value={waiting} tone="wait" />
          <Stat label="Seen" value={seen} tone="ok" />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="bg-gradient-to-br from-brand-soft/80 to-card">
            <p className="text-xs font-semibold uppercase tracking-wide text-brand">
              Active camp
            </p>
            <p className="mt-0.5 text-xl font-bold tracking-tight">
              {active?.name || "None set"}
            </p>
            {active?.venue ? (
              <p className="text-sm text-muted">{active.venue}</p>
            ) : null}
            <p className="mt-2 text-xs text-muted">
              {volunteers?.length ?? 0} volunteer
              {(volunteers?.length ?? 0) === 1 ? "" : "s"} on staff ·{" "}
              {patients.length} patient{patients.length === 1 ? "" : "s"} total
            </p>
            <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
              <NavLink href="/register" variant="primary">
                Register patient
              </NavLink>
              <NavLink href="/volunteer" variant="soft">
                Open volunteer desk
              </NavLink>
            </div>
          </Card>

          {active ? <SeatBoard days={days} title="Live seat board" /> : null}
        </div>

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

        <AdminPatients initial={patients} />
        <AdminVolunteers initial={volunteers || []} />

        <SignOutButton />
      </div>
    </Shell>
  );
}
