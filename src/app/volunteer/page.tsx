import { Suspense } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  getSessionProfile,
  isStaff,
  isAdmin,
  isTeamLead,
  roleHome,
} from "@/lib/auth";
import {
  ActionCard,
  Card,
  ErrorBox,
  NavLink,
  Shell,
} from "@/components/ui";
import type { LiveQueuePatient } from "@/components/live-queue";
import { SignOutButton } from "@/components/sign-out";
import { loadQueueSection } from "@/lib/section-reads";
import { mapDbError } from "@/lib/public-error";
import { DeskScanQueue } from "@/components/desk-scan-queue";
import { AdminStaff } from "@/components/admin-staff";
import { VolunteerDeskMore } from "@/components/volunteer-desk-more";
import type { StaffPerson } from "@/components/staff-detail";

export default async function VolunteerPage() {
  const { userId, profile } = await getSessionProfile();
  // Staff only (admin | team_lead | volunteer). Anyone else goes to roleHome,
  // or /login when they hold no login role at all.
  if (!isStaff(profile?.role)) {
    redirect(roleHome(profile?.role) || "/login");
  }

  const supabase = await createClient();
  const admin = isAdmin(profile?.role);
  const teamLead = isTeamLead(profile?.role);

  if (admin) {
    // No narrower-query fallback — column failures (incl. RLS) surface as errors.
    const [
      { data: volunteers, error },
      { data: teamLeads, error: teamLeadsError },
    ] = await Promise.all([
      supabase
        .from("profiles")
        .select("id, full_name, email, phone, role, created_at, disabled_at, team_lead_id")
        .eq("role", "volunteer")
        .order("created_at", { ascending: false }),
      supabase
        .from("profiles")
        .select("id, full_name, disabled_at")
        .eq("role", "team_lead")
        .order("full_name"),
    ]);

    if (error || teamLeadsError) {
      mapDbError(error || teamLeadsError, {
        context: "volunteer-page.admin-list",
      });
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
              <AdminStaff
                role="volunteer"
                initial={volunteers || []}
                canManage
                teamLeadOptions={(teamLeads ?? []).filter(
                  (lead) => !lead.disabled_at,
                )}
              />
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
  let teamVolunteers: StaffPerson[] = [];
  let rosterError: string | null = null;

  // A team lead manages their own roster from the desk. Read it before the camp
  // gate below: the roster exists whether or not a camp is active.
  if (teamLead && userId) {
    const { data: roster, error: rosterQueryError } = await supabase
      .from("profiles")
      .select("id, full_name, email, phone, role, created_at, disabled_at")
      .eq("role", "volunteer")
      .eq("team_lead_id", userId)
      .order("created_at", { ascending: false });

    if (rosterQueryError) {
      mapDbError(rosterQueryError, { context: "volunteer-page.team-roster" });
      rosterError = "Your team roster could not be loaded. Refresh and try again.";
    } else {
      teamVolunteers = roster ?? [];
    }
  }

  // Queue only — seats / KPIs / leaderboard load behind Aur dekhein.
  if (camp) {
    const queueRes = await loadQueueSection(camp.id);
    if (queueRes.ok) {
      waiting = queueRes.data.waiting as LiveQueuePatient[];
      waitingCount = queueRes.data.waitingTotal;
      queueKnown = true;
    }
  }

  return (
    <Shell
      title="Volunteer desk"
      subtitle={
        profile?.full_name
          ? `${profile.full_name} · ${teamLead ? "Team Lead Desk" : "Register · Print · Scan"}`
          : "Register · Print · Scan"
      }
      width="xl"
      roleLabel={teamLead ? "Team Lead" : "Volunteer"}
      actions={<SignOutButton place="header" />}
      dock={[
        { href: "/register", label: "Register", primary: true },
        { href: "#scan", label: "Scan patient" },
        { href: "#queue", label: "Queue" },
      ]}
    >
      <div className="space-y-3 sm:space-y-4">
        {rosterError ? <ErrorBox message={rosterError} /> : null}

        <Card className="bg-brand-soft !p-4 sm:!p-5">
          <p className="text-[0.6875rem] font-bold uppercase tracking-wide text-brand sm:text-xs">
            Active camp
          </p>
          <p className="text-lg font-bold tracking-tight sm:text-2xl">
            {camp?.name || "None"}
          </p>
          {camp?.venue ? (
            <p className="text-sm text-muted sm:text-[0.9375rem]">{camp.venue}</p>
          ) : null}
        </Card>

        <ActionCard
          href="/register"
          title="Naya marij register karein"
          description="Naam, phone, Aadhaar — phir parchi print"
          variant="primary"
          disabled={!camp}
          disabledReason="Koi active camp nahi. Admin se camp chalu karwayein."
        />

        <DeskScanQueue
          campId={camp?.id ?? null}
          waiting={waiting}
          waitingTotal={waitingCount}
          queueKnown={queueKnown || !camp}
          noCampReason={
            camp
              ? undefined
              : "No active camp. Ask an admin to activate a camp first."
          }
          scanTitle="Marij scan karein"
          scanHint="QR scan karein, ya number/naam likhein"
          queueTitle="Line (queue)"
          queueHint="Pehle aao, pehle pao · live"
        />

        <VolunteerDeskMore
          campId={camp?.id ?? null}
          currentUserId={userId ?? ""}
          teamVolunteers={teamLead ? teamVolunteers : undefined}
          hasActiveCamp={Boolean(camp)}
        />
      </div>
    </Shell>
  );
}
