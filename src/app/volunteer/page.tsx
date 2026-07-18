import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile, isStaff, isDoctor, isAdmin } from "@/lib/auth";
import type { CampDayStats } from "@/lib/types";
import {
  Card,
  NavLink,
  SectionTitle,
  Shell,
  Stat,
} from "@/components/ui";
import { QrScanner, type DoctorOption } from "@/components/qr-scanner";
import { SignOutButton } from "@/components/sign-out";
import { LiveQueue, type LiveQueuePatient } from "@/components/live-queue";
import { AdminVolunteers } from "@/components/admin-volunteers";
import { SeatBoard } from "@/components/seat-board";

export default async function VolunteerPage() {
  const { userId, profile } = await getSessionProfile();
  if (!isStaff(profile?.role)) redirect("/login");
  if (isDoctor(profile?.role)) redirect("/doctor");

  const supabase = await createClient();
  const admin = isAdmin(profile?.role);

  // Admin volunteer desk = manage volunteers only (no scanner / queue).
  if (admin) {
    const { data: volunteers, error } = await supabase
      .from("profiles")
      .select("id, full_name, email, phone, role, created_at")
      .eq("role", "volunteer")
      .order("created_at", { ascending: false });
    if (error) throw new Error("Volunteer desk data could not be loaded");

    return (
      <Shell
        title="Volunteer desk"
        subtitle="Manage volunteers · KPIs · add / remove"
        width="xl"
        roleLabel="Admin"
        actions={<SignOutButton place="header" />}
      >
        <div className="space-y-4">
          <Card className="bg-gradient-to-br from-brand-soft/70 to-card">
            <p className="text-xs font-bold uppercase tracking-wide text-brand">
              Staff management
            </p>
            <p className="text-xl font-bold tracking-tight">
              {volunteers?.length ?? 0} volunteer
              {(volunteers?.length ?? 0) === 1 ? "" : "s"}
            </p>
            <p className="mt-1 text-sm text-muted">
              Tap a volunteer for their KPIs and patients. Scanner and live
              queue live on the main admin dashboard.
            </p>
            <div className="desk-inline-actions mt-4">
              <NavLink href="/admin" variant="soft">
                Back to admin
              </NavLink>
            </div>
          </Card>
          <Card>
            <AdminVolunteers initial={volunteers || []} canManage />
          </Card>
        </div>
      </Shell>
    );
  }

  // Volunteer operational desk — own KPIs only.
  const { data: camp, error: campError } = await supabase
    .from("camps")
    .select("id, name, venue")
    .eq("is_active", true)
    .maybeSingle();

  const kolkataDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const startOfDay = new Date(kolkataDate + "T00:00:00+05:30").toISOString();

  const [waitingRes, doctorsRes, dayStatsRes, myTotalRes, myTodayRes, myWaitRes, mySeenRes] =
    camp
      ? await Promise.all([
          supabase
            .from("patients")
            .select("id, reg_no, full_name, phone, queued_at", {
              count: "exact",
            })
            .eq("camp_id", camp.id)
            .eq("queue_status", "waiting")
            .order("queued_at", { ascending: true, nullsFirst: false })
            .limit(100),
          supabase
            .from("profiles")
            .select("id, full_name")
            .eq("role", "doctor")
            .order("full_name", { ascending: true }),
          supabase.rpc("camp_day_stats", { p_camp_id: camp.id }),
          supabase
            .from("patients")
            .select("id", { count: "exact", head: true })
            .eq("created_by", userId!),
          supabase
            .from("patients")
            .select("id", { count: "exact", head: true })
            .eq("created_by", userId!)
            .gte("created_at", startOfDay),
          supabase
            .from("patients")
            .select("id", { count: "exact", head: true })
            .eq("created_by", userId!)
            .eq("queue_status", "waiting"),
          supabase
            .from("patients")
            .select("id", { count: "exact", head: true })
            .eq("created_by", userId!)
            .eq("queue_status", "seen"),
        ])
      : await Promise.all([
          Promise.resolve({ data: [] as LiveQueuePatient[], count: 0 }),
          Promise.resolve({ data: [] as DoctorOption[] }),
          Promise.resolve({ data: [] as CampDayStats[] }),
          Promise.resolve({ count: 0 }),
          Promise.resolve({ count: 0 }),
          Promise.resolve({ count: 0 }),
          Promise.resolve({ count: 0 }),
        ]);

  if (
    Boolean(campError) ||
    [waitingRes, doctorsRes, myTotalRes, myTodayRes, myWaitRes, mySeenRes].some(
      (result) => "error" in result && Boolean(result.error),
    )
  ) {
    throw new Error("Volunteer desk data could not be loaded");
  }

  const waiting = (waitingRes.data || []) as LiveQueuePatient[];
  const waitingCount = waitingRes.count ?? waiting.length;
  const doctors = (doctorsRes.data || []) as DoctorOption[];
  const days = (dayStatsRes.data as CampDayStats[]) || [];

  return (
    <Shell
      title="Volunteer desk"
      subtitle={
        profile?.full_name
          ? `${profile.full_name} · Register · Print · Scan`
          : "Register · Print · Scan"
      }
      width="xl"
      roleLabel="Volunteer"
      actions={<SignOutButton place="header" />}
    >
      <div className="space-y-4">
        <Card className="bg-gradient-to-br from-brand-soft/70 to-card">
          <div className="flex flex-col gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-brand">
                Active camp
              </p>
              <p className="text-xl font-bold tracking-tight sm:text-2xl">
                {camp?.name || "None"}
              </p>
              {camp?.venue ? (
                <p className="text-[0.9375rem] text-muted">{camp.venue}</p>
              ) : null}
            </div>
            <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat
                label="You registered"
                value={myTotalRes.count ?? 0}
                tone="ok"
              />
              <Stat label="Today" value={myTodayRes.count ?? 0} />
              <Stat
                label="In queue"
                value={myWaitRes.count ?? 0}
                tone="wait"
              />
              <Stat
                label="Doctor seen"
                value={mySeenRes.count ?? 0}
                tone="ok"
              />
            </div>
          </div>
          <div className="desk-inline-actions mt-4">
            <NavLink href="/register" variant="primary">
              Register walk-in patient
            </NavLink>
          </div>
        </Card>

        {camp ? (
          <SeatBoard
            days={days}
            campId={camp.id}
            title="Live seat board"
            compact
          />
        ) : null}

        <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
          <Card id="scan">
            <SectionTitle hint="After print · pick doctor">
              Scan / assign doctor
            </SectionTitle>
            <QrScanner
              mode="volunteer"
              doctors={doctors}
              disabledReason={
                camp
                  ? undefined
                  : "No active camp. Ask an admin to activate a camp first."
              }
            />
          </Card>

          <Card padding="sm" id="queue">
            <div className="px-1 pt-1">
              <SectionTitle hint="First come, first served">
                Live queue
              </SectionTitle>
            </div>
            <LiveQueue
              initial={waiting}
              initialTotal={waitingCount}
              campId={camp?.id ?? null}
              doctors={doctors}
              mode="volunteer"
            />
          </Card>
        </div>
      </div>
    </Shell>
  );
}
