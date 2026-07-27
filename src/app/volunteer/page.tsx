import { Suspense } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  getSessionProfile,
  isStaff,
  isAdmin,
  roleHome,
} from "@/lib/auth";
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
import type { CampDayStats, DoctorOption } from "@/lib/types";
import {
  loadAwaitingTreatmentSection,
  loadDoctorsSection,
  loadQueueSection,
  loadSeatsSection,
  loadVolunteerKpisSection,
  type AwaitingTreatmentData,
  type SectionResult,
} from "@/lib/section-reads";
import { mapDbError } from "@/lib/public-error";
import {
  AwaitingTreatmentCard,
  VolunteerKpisSection,
} from "@/components/section-data";
import { DeskScanQueue } from "@/components/desk-scan-queue";
import { SeatBoard } from "@/components/seat-board";
import { CheckIn } from "@/components/check-in";
import { AdminStaff } from "@/components/admin-staff";

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

  let waiting: LiveQueuePatient[] = [];
  let waitingCount = 0;
  let queueKnown = false;
  let days: CampDayStats[] = [];
  let seatsKnown = false;
  let doctorsInitial:
    | { ok: true; data: DoctorOption[] }
    | { ok: false; error: string } = {
    ok: true,
    data: [],
  };
  let kpisInitial:
    | {
        ok: true;
        data: {
          total: number;
          today: number;
          waiting: number;
          seen: number;
        };
      }
    | { ok: false; error: string }
    | null = null;
  let awaitingInitial: SectionResult<AwaitingTreatmentData> | null = null;

  if (camp && userId) {
    // Independent loads — one failure must not blank the rest of the desk.
    const [queueRes, seatsRes, doctorsRes, kpisRes, awaitingRes] =
      await Promise.all([
        loadQueueSection(camp.id),
        loadSeatsSection(camp.id),
        loadDoctorsSection(),
        loadVolunteerKpisSection(camp.id, userId),
        loadAwaitingTreatmentSection(camp.id),
      ]);

    if (queueRes.ok) {
      waiting = queueRes.data.waiting as LiveQueuePatient[];
      waitingCount = queueRes.data.waitingTotal;
      queueKnown = true;
    }

    if (seatsRes.ok) {
      days = seatsRes.data.days;
      seatsKnown = true;
    }

    doctorsInitial = doctorsRes;
    kpisInitial = kpisRes;
    awaitingInitial = awaitingRes;
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
        { href: "/counter", label: "Counter" },
        { href: "#checkin", label: "Check-in" },
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
            {camp && kpisInitial ? (
              <VolunteerKpisSection campId={camp.id} initial={kpisInitial} />
            ) : (
              <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="You handled" value={0} tone="ok" />
                <Stat label="Handled today" value={0} />
                <Stat label="In queue" value={0} tone="wait" />
                <Stat label="Doctor seen" value={0} tone="ok" />
              </div>
            )}
            {!camp ? (
              <p className="mt-2 text-sm text-muted" role="status">
                No active camp — these numbers stay at zero until an admin
                activates one. They are not a career total.
              </p>
            ) : null}
          </div>

          <div className="mt-3">
            <AwaitingTreatmentCard
              campId={camp?.id ?? null}
              initial={awaitingInitial}
            />
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
              <a href="#checkin" className="jump-chip">
                Check-in
              </a>
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
            <NavLink href="/counter" variant="soft">
              Counter desk
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
            live
            initialLoadKnown={seatsKnown}
          />
        ) : null}

        <Card id="checkin" className="!p-4 sm:!p-5">
          <SectionTitle hint="Pre-registered only · reg # · name · QR paste">
            Check-in
          </SectionTitle>
          <Suspense
            fallback={
              <p role="status" className="py-4 text-xs text-muted">
                Loading check-in…
              </p>
            }
          >
            <CheckIn
              campId={camp?.id ?? null}
              disabledReason={
                camp
                  ? undefined
                  : "No active camp. Ask an admin to activate a camp first."
              }
            />
          </Suspense>
        </Card>

        <DeskScanQueue
          mode="volunteer"
          campId={camp?.id ?? null}
          doctorsInitial={doctorsInitial}
          waiting={waiting}
          waitingTotal={waitingCount}
          queueKnown={queueKnown || !camp}
          noCampReason={
            camp
              ? undefined
              : "No active camp. Ask an admin to activate a camp first."
          }
        />
      </div>
    </Shell>
  );
}
