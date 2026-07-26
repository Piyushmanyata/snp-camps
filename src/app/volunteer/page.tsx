import { Suspense } from "react";
import dynamic from "next/dynamic";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  getSessionProfile,
  isStaff,
  isAdmin,
  roleHome,
} from "@/lib/auth";
import type { CampDayStats } from "@/lib/types";
import {
  ActionCard,
  Card,
  NavLink,
  SectionTitle,
  Shell,
  Stat,
} from "@/components/ui";
import type { LiveQueuePatient } from "@/components/live-queue";
import { SignOutButton } from "@/components/sign-out";
import {
  DOCTOR_LIST_UNAVAILABLE,
  getDoctorsList,
} from "@/lib/metadata";
import type { DoctorOption } from "@/lib/types";
import { mapDbError } from "@/lib/public-error";
import { SectionLoadError } from "@/components/section-load-error";

const LiveQueue = dynamic(
  () =>
    import("@/components/live-queue").then((m) => ({ default: m.LiveQueue })),
  {
    loading: () => <p role="status" className="py-4 text-xs text-muted">Loading queue…</p>,
  },
);

const SeatBoard = dynamic(
  () =>
    import("@/components/seat-board").then((m) => ({ default: m.SeatBoard })),
  {
    loading: () => <p role="status" className="py-4 text-xs text-muted">Loading seat board…</p>,
  },
);

const QrScanner = dynamic(
  () =>
    import("@/components/qr-scanner").then((m) => ({ default: m.QrScanner })),
  {
    loading: () => (
      <p role="status" className="py-6 text-center text-sm text-muted">Loading scanner…</p>
    ),
  },
);

const AdminStaff = dynamic(
  () =>
    import("@/components/admin-staff").then((m) => ({
      default: m.AdminStaff,
    })),
  {
    loading: () => (
      <p role="status" className="py-4 text-xs text-muted">Loading volunteers…</p>
    ),
  },
);

export default async function VolunteerPage() {
  const { userId, profile } = await getSessionProfile();
  // Staff only (admin | volunteer). Doctors hit roleHome → /doctor; no
  // second-order redirect that depends on check order.
  if (!isStaff(profile?.role)) {
    redirect(roleHome(profile?.role) || "/login");
  }

  const supabase = await createClient();
  const admin = isAdmin(profile?.role);

  if (admin) {
    // No narrower-query fallback — column failures (incl. RLS) surface as errors.
    const { data: volunteers, error } = await supabase
      .from("profiles")
      .select("id, full_name, email, phone, role, created_at, disabled_at")
      .eq("role", "volunteer")
      .order("created_at", { ascending: false });

    if (error) {
      mapDbError(error, { context: "volunteer-page.admin-list" });
      throw new Error("Volunteer desk data could not be loaded");
    }
    const activeVolunteers =
      volunteers?.filter((volunteer) => !volunteer.disabled_at).length ?? 0;
    const disabledVolunteers = (volunteers?.length ?? 0) - activeVolunteers;

    return (
      <Shell
        title="Volunteer desk"
        subtitle="Manage volunteers · KPIs · account access"
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
          <Card className="bg-brand-soft">
            <p className="text-xs font-bold uppercase tracking-wide text-brand">
              Staff management
            </p>
            <p className="text-xl font-bold tracking-tight">
              {activeVolunteers} active volunteer{activeVolunteers === 1 ? "" : "s"}
            </p>
            <p className="mt-1 text-sm text-muted">
              {disabledVolunteers
                ? `${disabledVolunteers} disabled · `
                : ""}
              Tap a volunteer for their KPIs and patients. Scanner and queue live
              on the main admin dashboard.
            </p>
            <div className="desk-inline-actions mt-4">
              <NavLink href="/admin" variant="soft">
                Back to admin
              </NavLink>
            </div>
          </Card>
          <Card>
            <Suspense fallback={<p role="status" className="py-4 text-xs text-muted">Loading volunteers…</p>}>
              <AdminStaff role="volunteer" initial={volunteers || []} canManage />
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

  if (campError) {
    mapDbError(campError, { context: "volunteer-page.active-camp" });
    throw new Error("Volunteer desk data could not be loaded");
  }

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

  let queueError: string | null = null;
  let doctorsError: string | null = null;
  let seatsError: string | null = null;
  let kpisError: string | null = null;

  if (camp && userId) {
    // Independent loads — one failure must not blank the rest of the desk.
    const [waitingRes, doctorsOutcome, dayStatsRes, myCountsRes] =
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
        getDoctorsList()
          .then((list) => ({ ok: true as const, list }))
          .catch((err: unknown) => ({ ok: false as const, err })),
        supabase.rpc("camp_day_stats", { p_camp_id: camp.id }),
        supabase.rpc("staff_person_kpis", {
          p_user_id: userId,
          p_role: "volunteer",
          p_camp_id: camp.id,
          p_since: startOfDay,
        }),
      ]);

    if (waitingRes.error) {
      queueError = mapDbError(waitingRes.error, {
        context: "volunteer-page.queue",
        fallback: "Queue could not be loaded — retry.",
      });
    } else {
      waiting = (waitingRes.data || []) as LiveQueuePatient[];
      waitingCount = waitingRes.count ?? waiting.length;
    }

    if (!doctorsOutcome.ok) {
      doctorsError = mapDbError(doctorsOutcome.err, {
        context: "volunteer-page.doctors",
        fallback: DOCTOR_LIST_UNAVAILABLE,
      });
    } else {
      doctors = doctorsOutcome.list;
    }

    if (dayStatsRes.error) {
      seatsError = mapDbError(dayStatsRes.error, {
        context: "volunteer-page.seats",
        fallback: "Seat board could not be loaded — retry.",
      });
    } else {
      days = (dayStatsRes.data as CampDayStats[]) || [];
    }

    if (myCountsRes.error) {
      kpisError = mapDbError(myCountsRes.error, {
        context: "volunteer-page.kpis",
        fallback: "Your stats could not be loaded — retry.",
      });
    } else {
      const myCounts = myCountsRes.data?.[0];
      myTotal = Number(myCounts?.total ?? 0);
      myToday = Number(myCounts?.today ?? 0);
      myWait = Number(myCounts?.waiting ?? 0);
      mySeen = Number(myCounts?.seen ?? 0);
    }
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
        <Card className="bg-brand-soft !p-4 sm:!p-5">
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
            {kpisError ? (
              <SectionLoadError message={kpisError} />
            ) : (
              <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="You handled" value={myTotal} tone="ok" />
                <Stat label="Handled today" value={myToday} />
                <Stat label="In queue" value={myWait} tone="wait" />
                <Stat label="Doctor seen" value={mySeen} tone="ok" />
              </div>
            )}
            {!camp ? (
              <p className="mt-2 text-sm text-muted" role="status">
                No active camp — these numbers stay at zero until an admin
                activates one. They are not a career total.
              </p>
            ) : null}
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
          seatsError ? (
            <Card>
              <SectionTitle>Seat board</SectionTitle>
              <SectionLoadError message={seatsError} />
            </Card>
          ) : (
            <SeatBoard
              days={days}
              campId={camp.id}
              title="Seat board"
              compact
              pollMs={0}
              live
            />
          )
        ) : null}

        <div className="grid gap-3 sm:gap-4 lg:grid-cols-2 lg:items-start">
          <Card id="scan" className="!p-4 sm:!p-5">
            <SectionTitle hint="Scan paper or phone QR · pick doctor">
              Scan / assign doctor
            </SectionTitle>
            {doctorsError ? (
              <SectionLoadError message={doctorsError} />
            ) : null}
            <Suspense fallback={<p role="status" className="py-6 text-center text-sm text-muted">Loading scanner…</p>}>
              <QrScanner
                mode="volunteer"
                doctors={doctors}
                disabledReason={
                  camp
                    ? doctorsError
                      ? DOCTOR_LIST_UNAVAILABLE
                      : undefined
                    : "No active camp. Ask an admin to activate a camp first."
                }
              />
            </Suspense>
          </Card>

          <Card padding="sm" id="queue">
            <div className="px-1 pt-1">
              <SectionTitle hint="FCFS · live">
                Queue
              </SectionTitle>
            </div>
            {queueError ? (
              <div className="px-1 pb-2">
                <SectionLoadError message={queueError} />
              </div>
            ) : (
              <LiveQueue
                initial={waiting}
                initialTotal={waitingCount}
                campId={camp?.id ?? null}
                doctors={doctors}
                mode="volunteer"
              />
            )}
          </Card>
        </div>
      </div>
    </Shell>
  );
}
