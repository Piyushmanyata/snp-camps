import { redirect } from "next/navigation";
import { getSessionProfile, roleHome } from "@/lib/auth";
import type { CampDayStats, Camp } from "@/lib/types";
import {
  Card,
  CollapsibleSection,
  NavLink,
  Shell,
} from "@/components/ui";
import { SignOutButton } from "@/components/sign-out";
import type { LiveQueuePatient } from "@/components/live-queue";
import { getCampsList } from "@/lib/metadata";
import {
  loadAdminQueueCountsSection,
  loadQueueSection,
  loadSeatsSection,
  loadStaffLeaderboardSection,
  type StaffKpiRow,
} from "@/lib/section-reads";
import { TeamLeadPanel } from "@/components/team-lead-panel";
import { mapDbError } from "@/lib/public-error";
import {
  AdminAnalyticsPanel,
  CampsLoadFailed,
} from "@/components/section-data";
import { DeskScanQueue } from "@/components/desk-scan-queue";
import { SeatBoard } from "@/components/seat-board";
import { AdminCamps } from "@/components/admin-camps";
import { AdminCampDays } from "@/components/admin-camp-days";
import { AdminSettingsPanel } from "@/components/admin-settings-panel";
import { ChangePasswordLazySection } from "@/components/admin-optional-lazy";

export default async function AdminPage() {
  const { userId, profile } = await getSessionProfile();
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
          seen: number;
          total: number;
          currentLongestWaitMinutes: number | null;
          completedWaitMedianMinutes: number | null;
          completedWaitP90Minutes: number | null;
          completedToday: number;
          deskRegistrations: number;
          selfRegistrations: number;
          scannedRegistrations: number;
          selfDeclaredRegistrations: number;
        };
      }
    | { ok: false; error: string }
    | null = null;
  let days: CampDayStats[] = [];
  let seatsKnown = false;
  let waiting: LiveQueuePatient[] = [];
  let waitingCount = 0;
  let queueKnown = false;
  let leaderboard: StaffKpiRow[] = [];

  if (active) {
    const [statsRes, seatsRes, queueRes, leaderboardRes] = await Promise.all([
      loadAdminQueueCountsSection(active.id),
      loadSeatsSection(active.id),
      loadQueueSection(active.id),
      loadStaffLeaderboardSection(active.id),
    ]);
    if (leaderboardRes.ok) leaderboard = leaderboardRes.data;
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
  }

  const leadCount = leaderboard.filter((r) => r.role === "team_lead").length;
  const volunteerCount = leaderboard.filter((r) => r.role === "volunteer").length;

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
              { href: "#scan", label: "Scan patient", primary: true },
              { href: "/register", label: "Register" },
              { href: "/team-lead", label: "Team Leads" },
              { href: "/admin/clinical-operators", label: "Clinical Accounts" },
              { href: "/admin/patients", label: "Patients" },
            ]
          : [
              { href: "/register", label: "Register", primary: true },
              { href: "/team-lead", label: "Team Leads" },
              { href: "/admin/clinical-operators", label: "Clinical Accounts" },
              { href: "/admin/patients", label: "Patients" },
              { href: "/volunteer", label: "Staff management" },
            ]
      }
    >
      <div className="space-y-3 sm:space-y-4 lg:space-y-5">
        <AdminAnalyticsPanel campId={active?.id ?? null} initial={statsInitial} />

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
            <div className="grid grid-cols-2 gap-2">
              <NavLink href="/admin/patients" variant="soft">
                Patients
              </NavLink>
              <NavLink href="/team-lead" variant="soft">
                Team Leads
              </NavLink>
              <NavLink href="/volunteer" variant="soft">
                Volunteers
              </NavLink>
              <NavLink href="/admin/clinical-operators" variant="soft">
                Clinical accounts
              </NavLink>
            </div>
          </div>
          <div className="desk-inline-actions mt-4 gap-2.5 sm:grid-cols-2">
            <NavLink href="/register" variant="primary">
              Register patient
            </NavLink>
            <NavLink href="/team-lead" variant="soft">
              Team Lead desk
            </NavLink>
            <NavLink href="/volunteer" variant="soft">
              Volunteer desk
            </NavLink>
            <NavLink href="/admin/patients" variant="soft">
              Patient desk
            </NavLink>
            <NavLink href="/admin/clinical" variant="soft">
              Clinical records
            </NavLink>
            <NavLink href="/admin/clinical-operators" variant="soft">
              Clinical Desk Accounts
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
            <DeskScanQueue
              campId={active.id}
              waiting={waiting}
              waitingTotal={waitingCount}
              queueKnown={queueKnown}
            />

            <CollapsibleSection
              title="Teams & leaderboards"
              hint={`${leadCount} team lead${leadCount === 1 ? "" : "s"} · ${volunteerCount} volunteer${volunteerCount === 1 ? "" : "s"}`}
            >
              <TeamLeadPanel
                currentUserId={userId ?? ""}
                initialLeaderboard={leaderboard}
                hasActiveCamp
              />
            </CollapsibleSection>
            <AdminSettingsPanel camp={active} />
          </div>
        ) : null}

        <ChangePasswordLazySection />
      </div>
    </Shell>
  );
}
