import { Suspense } from "react";
import dynamic from "next/dynamic";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile, isStaff, isDoctor, isAdmin } from "@/lib/auth";
import type { CampDayStats } from "@/lib/types";
import {
  ActionCard,
  Card,
  NavLink,
  SectionTitle,
  Shell,
  Stat,
} from "@/components/ui";
import type { DoctorOption } from "@/components/qr-scanner";
import type { LiveQueuePatient } from "@/components/live-queue";
import { SignOutButton } from "@/components/sign-out";
import { getDoctorsList } from "@/lib/metadata";

const ChangePasswordCard = dynamic(
  () =>
    import("@/components/change-password").then((m) => ({
      default: m.ChangePasswordCard,
    })),
  {
    loading: () => <p className="py-2 text-xs text-muted">Loading...</p>,
  },
);

const LiveQueue = dynamic(
  () =>
    import("@/components/live-queue").then((m) => ({ default: m.LiveQueue })),
  {
    loading: () => <p className="py-4 text-xs text-muted">Loading queue…</p>,
  },
);

const SeatBoard = dynamic(
  () =>
    import("@/components/seat-board").then((m) => ({ default: m.SeatBoard })),
  {
    loading: () => <p className="py-4 text-xs text-muted">Loading seat board…</p>,
  },
);

const QrScanner = dynamic(
  () =>
    import("@/components/qr-scanner").then((m) => ({ default: m.QrScanner })),
  {
    loading: () => (
      <p className="py-6 text-center text-sm text-muted">Loading scanner…</p>
    ),
  },
);

const AdminVolunteers = dynamic(
  () =>
    import("@/components/admin-volunteers").then((m) => ({
      default: m.AdminVolunteers,
    })),
  {
    loading: () => (
      <p className="py-4 text-xs text-muted">Loading volunteers…</p>
    ),
  },
);

export default async function VolunteerPage() {
  const { profile } = await getSessionProfile();
  if (!isStaff(profile?.role)) redirect("/login");
  if (isDoctor(profile?.role)) redirect("/doctor");

  const supabase = await createClient();
  const admin = isAdmin(profile?.role);

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
        dock={[
          { href: "/admin", label: "Admin" },
          { href: "/register", label: "Register", primary: true },
          { href: "/admin/patients", label: "Patients" },
        ]}
      >
        <div className="space-y-3 sm:space-y-4">
          <Card className="bg-gradient-to-br from-brand-soft/70 to-card">
            <p className="text-xs font-bold uppercase tracking-wide text-brand">
              Staff management
            </p>
            <p className="text-xl font-bold tracking-tight">
              {volunteers?.length ?? 0} volunteer
              {(volunteers?.length ?? 0) === 1 ? "" : "s"}
            </p>
            <p className="mt-1 text-sm text-muted">
              Tap a volunteer for their KPIs and patients. Scanner and queue
              live on the main admin dashboard.
            </p>
            <div className="desk-inline-actions mt-4">
              <NavLink href="/admin" variant="soft">
                Back to admin
              </NavLink>
            </div>
          </Card>
          <Card>
            <Suspense fallback={<p className="py-4 text-xs text-muted">Loading volunteers…</p>}>
              <AdminVolunteers initial={volunteers || []} canManage />
            </Suspense>
          </Card>
        </div>
      </Shell>
    );
  }

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

  let waiting: LiveQueuePatient[] = [];
  let waitingCount = 0;
  let doctors: DoctorOption[] = [];
  let days: CampDayStats[] = [];
  let myTotal = 0;
  let myToday = 0;
  let myWait = 0;
  let mySeen = 0;

  if (camp) {
    const [waitingRes, doctorsList, dayStatsRes, myCountsRes] =
      await Promise.all([
        supabase
          .from("patients")
          .select("id, reg_no, full_name, phone, queued_at", {
            count: "exact",
          })
          .eq("camp_id", camp.id)
          .eq("queue_status", "waiting")
          .order("queued_at", { ascending: true, nullsFirst: false })
          .limit(100),
        getDoctorsList(),
        supabase.rpc("camp_day_stats", { p_camp_id: camp.id }),
        supabase.rpc("volunteer_my_counts", { p_since: startOfDay }),
      ]);

    if (
      waitingRes.error ||
      dayStatsRes.error ||
      myCountsRes.error
    ) {
      throw new Error("Volunteer desk data could not be loaded");
    }

    waiting = (waitingRes.data || []) as LiveQueuePatient[];
    waitingCount = waitingRes.count ?? waiting.length;
    doctors = doctorsList;
    days = (dayStatsRes.data as CampDayStats[]) || [];
    const myCounts = myCountsRes.data?.[0];
    myTotal = Number(myCounts?.total ?? 0);
    myToday = Number(myCounts?.today ?? 0);
    myWait = Number(myCounts?.waiting ?? 0);
    mySeen = Number(myCounts?.seen ?? 0);
  } else if (campError) {
    throw new Error("Volunteer desk data could not be loaded");
  }

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
      dock={[
        { href: "/register", label: "Register", primary: true },
        { href: "#scan", label: "Scan" },
        { href: "#queue", label: "Queue" },
      ]}
    >
      <div className="space-y-3 sm:space-y-4">
        <ChangePasswordCard />
        <Card className="bg-gradient-to-br from-brand-soft/70 to-card !p-4 sm:!p-5">
          <div className="flex flex-col gap-3">
            <div>
              <p className="text-[0.6875rem] font-bold uppercase tracking-wide text-brand sm:text-xs">
                Active camp
              </p>
              <p className="text-lg font-bold tracking-tight sm:text-2xl">
                {camp?.name || "None"}
              </p>
              {camp?.venue ? (
                <p className="text-sm text-muted sm:text-[0.9375rem]">
                  {camp.venue}
                </p>
              ) : null}
            </div>
            <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="You registered" value={myTotal} tone="ok" />
              <Stat label="Today" value={myToday} />
              <Stat label="In queue" value={myWait} tone="wait" />
              <Stat label="Doctor seen" value={mySeen} tone="ok" />
            </div>
          </div>

          {/* Always visible on phone — desk-inline-actions is desktop-only */}
          <div className="mt-3 space-y-2 lg:hidden">
            <ActionCard
              href="/register"
              title="Register walk-in"
              description={
                camp
                  ? "New patient · name, phone, day"
                  : "Needs an active camp first"
              }
              variant="primary"
              disabled={!camp}
              disabledReason="No active camp. Ask admin to activate one."
            />
            <div className="jump-chip-row" aria-label="Jump to section">
              <a href="#scan" className="jump-chip">
                Scan QR
              </a>
              <a href="#queue" className="jump-chip">
                Live queue
              </a>
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
            title="Seat board"
            compact
            pollMs={0}
          />
        ) : null}

        <div className="grid gap-3 sm:gap-4 lg:grid-cols-2 lg:items-start">
          <Card id="scan" className="!p-4 sm:!p-5">
            <SectionTitle hint="Scan paper or phone QR · pick doctor">
              Scan / assign doctor
            </SectionTitle>
            <Suspense fallback={<p className="py-6 text-center text-sm text-muted">Loading scanner…</p>}>
              <QrScanner
                mode="volunteer"
                doctors={doctors}
                disabledReason={
                  camp
                    ? undefined
                    : "No active camp. Ask an admin to activate a camp first."
                }
              />
            </Suspense>
          </Card>

          <Card padding="sm" id="queue">
            <div className="px-1 pt-1">
              <SectionTitle hint="FCFS · refresh manually">
                Queue
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
