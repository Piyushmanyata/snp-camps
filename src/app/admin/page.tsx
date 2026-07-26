import dynamic from "next/dynamic";
import { redirect } from "next/navigation";
import { getSessionProfile, roleHome } from "@/lib/auth";
import type { CampDayStats, Camp, DoctorOption } from "@/lib/types";
import {
  Card,
  CollapsibleSection,
  NavLink,
  SectionTitle,
  Shell,
} from "@/components/ui";
import { SignOutButton } from "@/components/sign-out";
import type { LiveQueuePatient } from "@/components/live-queue";
import { getCampsList } from "@/lib/metadata";
import {
  loadAdminQueueCountsSection,
  loadDoctorsSection,
  loadQueueSection,
  loadSeatsSection,
} from "@/lib/section-reads";
import { mapDbError } from "@/lib/public-error";
import { AdminHeaderStatsPanel } from "@/components/section-data";
import { DeskScanQueue } from "@/components/desk-scan-queue";
const SeatBoard = dynamic(
  () =>
    import("@/components/seat-board").then((m) => ({ default: m.SeatBoard })),
  {
    loading: () => <p role="status" className="py-4 text-xs text-muted">Loading seat board…</p>,
  },
);

const CheckIn = dynamic(
  () =>
    import("@/components/check-in").then((m) => ({ default: m.CheckIn })),
  {
    loading: () => (
      <p role="status" className="py-4 text-xs text-muted">Loading check-in…</p>
    ),
  },
);

const AdminCamps = dynamic(
  () => import("@/components/admin-camps").then((m) => ({ default: m.AdminCamps })),
  {
    loading: () => <p role="status" className="py-4 text-xs text-muted">Loading camps…</p>,
  },
);

const AdminCampDays = dynamic(
  () =>
    import("@/components/admin-camp-days").then((m) => ({
      default: m.AdminCampDays,
    })),
  {
    loading: () => <p role="status" className="py-4 text-xs text-muted">Loading camp days…</p>,
  },
);

const ChangePasswordCard = dynamic(
  () =>
    import("@/components/change-password-card").then((m) => ({
      default: m.ChangePasswordCard,
    })),
  {
    loading: () => <p role="status" className="py-4 text-xs text-muted">Loading password settings…</p>,
  },
);

const AdminTestSms = dynamic(
  () =>
    import("@/components/admin-test-sms").then((m) => ({
      default: m.AdminTestSms,
    })),
  {
    loading: () => (
      <p role="status" className="py-4 text-xs text-muted">
        Loading SMS tools…
      </p>
    ),
  },
);

const CampsLoadFailed = dynamic(
  () =>
    import("@/components/section-data").then((m) => ({
      default: m.CampsLoadFailed,
    })),
  {
    loading: () => (
      <Card>
        <p role="status" className="py-4 text-xs text-muted">
          Loading camps…
        </p>
      </Card>
    ),
  },
);

export default async function AdminPage() {
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") {
    redirect(roleHome(profile?.role) || "/login");
  }

  let camps: Camp[] = [];
  let campsError: string | null = null;
  try {
    camps = await getCampsList();
  } catch (err) {
    campsError = mapDbError(err, {
      context: "admin-page.camps",
      fallback: "Camps could not be loaded — retry.",
    });
  }

  const active = camps.find((c) => c.is_active);

  // Independent section results — no throw into Suspense (#63).
  let statsInitial:
    | {
        ok: true;
        data: {
          registered: number;
          inQueue: number;
          doctorSeen: number;
          avgWaitMinutes: number | null;
        };
      }
    | { ok: false; error: string }
    | null = null;
  let days: CampDayStats[] = [];
  let seatsKnown = false;
  let waiting: LiveQueuePatient[] = [];
  let waitingCount = 0;
  let queueKnown = false;
  let doctorsInitial:
    | { ok: true; data: DoctorOption[] }
    | { ok: false; error: string } = { ok: true, data: [] };

  if (active) {
    const [statsRes, seatsRes, queueRes, doctorsRes] = await Promise.all([
      loadAdminQueueCountsSection(active.id),
      loadSeatsSection(active.id),
      loadQueueSection(active.id),
      loadDoctorsSection(),
    ]);
    statsInitial = statsRes;
    if (seatsRes.ok) {
      days = seatsRes.data.days;
      seatsKnown = true;
    }
    if (queueRes.ok) {
      waiting = queueRes.data.waiting as LiveQueuePatient[];
      waitingCount = queueRes.data.waitingTotal;
      queueKnown = true;
    }
    doctorsInitial = doctorsRes;
  } else if (!campsError) {
    // No active camp — still try doctors for empty scanner readiness is N/A
    doctorsInitial = await loadDoctorsSection();
  }

  return (
    <Shell
      title="Admin"
      subtitle={profile?.full_name || "Camp control"}
      width="xl"
      roleLabel="Admin"
      actions={<SignOutButton place="header" />}
      dock={
        active
          ? [
              { href: "#checkin", label: "Check-in", primary: true },
              { href: "/register", label: "Register" },
              { href: "#scan", label: "Scan" },
              { href: "#queue", label: "Queue" },
              { href: "/admin/patients", label: "Patients" },
            ]
          : [
              { href: "/register", label: "Register", primary: true },
              { href: "/admin/patients", label: "Patients" },
              { href: "/volunteer", label: "Volunteers" },
              { href: "/doctor", label: "Doctors" },
            ]
      }
    >
      <div className="space-y-3 sm:space-y-4 lg:space-y-5">
        <AdminHeaderStatsPanel campId={active?.id ?? null} initial={statsInitial} />

        <Card className="bg-brand-soft !p-4 sm:!p-5">
          <p className="text-[0.6875rem] font-bold uppercase tracking-wide text-brand sm:text-xs">
            Active camp
          </p>
          <p className="mt-0.5 text-lg font-bold tracking-tight sm:text-2xl">
            {active?.name || "None set"}
          </p>
          {active?.venue ? (
            <p className="text-sm text-muted sm:text-[0.9375rem]">
              {active.venue}
            </p>
          ) : null}
          <div className="mt-3 grid gap-2 lg:hidden">
            <NavLink href="/register" variant="primary">
              Register patient
            </NavLink>
            <div className="grid grid-cols-3 gap-2">
              <NavLink href="/admin/patients" variant="soft">
                Patients
              </NavLink>
              <NavLink href="/volunteer" variant="soft">
                Volunteers
              </NavLink>
              <NavLink href="/doctor" variant="soft">
                Doctors
              </NavLink>
            </div>
          </div>
          <div className="desk-inline-actions mt-4 gap-2.5 sm:grid-cols-2">
            <NavLink href="/register" variant="primary">
              Register patient
            </NavLink>
            <NavLink href="/volunteer" variant="soft">
              Volunteer desk
            </NavLink>
            <NavLink href="/doctor" variant="soft">
              Doctor desk
            </NavLink>
            <NavLink href="/admin/patients" variant="soft">
              Patient desk
            </NavLink>
          </div>
        </Card>

        {campsError ? (
          <CampsLoadFailed message={campsError} />
        ) : !active ? (
          <CollapsibleSection
            title="Camps"
            hint={`${camps.length} total`}
            defaultOpen
          >
            <AdminCamps camps={camps} />
          </CollapsibleSection>
        ) : (
          <div className="space-y-3">
            <SeatBoard
              days={days}
              campId={active.id}
              title="Seat board"
              pollMs={0}
              live
              initialLoadKnown={seatsKnown}
            />
            <CollapsibleSection
              title="Camps & camp days"
              hint={`${camps.length} camp${camps.length === 1 ? "" : "s"} · ${days.length} day${days.length === 1 ? "" : "s"}`}
              defaultOpen={!days.length}
            >
              <div className="space-y-6">
                <div>
                  <p className="mb-2 text-sm font-semibold text-foreground">
                    Camp days — {active.name}
                  </p>
                  <AdminCampDays
                    campId={active.id}
                    campName={active.name}
                    initialDays={days}
                  />
                </div>
                <div className="border-t border-border pt-4">
                  <p className="mb-2 text-sm font-semibold text-foreground">
                    All camps
                  </p>
                  <AdminCamps camps={camps} />
                </div>
              </div>
            </CollapsibleSection>
          </div>
        )}

        {active ? (
          <div className="space-y-3 sm:space-y-4">
            <Card id="checkin" className="!p-4 sm:!p-5">
              <SectionTitle hint="Pre-registered only · reg # · name · QR paste">
                Check-in
              </SectionTitle>
              <CheckIn campId={active.id} />
            </Card>
            <DeskScanQueue
              mode="admin"
              campId={active.id}
              doctorsInitial={doctorsInitial}
              waiting={waiting}
              waitingTotal={waitingCount}
              queueKnown={queueKnown}
            />
          </div>
        ) : null}

        <CollapsibleSection
          title="Registration SMS (MSG91)"
          hint="Test send · recent failures"
          defaultOpen={false}
        >
          <AdminTestSms />
        </CollapsibleSection>

        <CollapsibleSection title="Account security" hint="Change password" defaultOpen={false}>
          <ChangePasswordCard />
        </CollapsibleSection>
      </div>
    </Shell>
  );
}
