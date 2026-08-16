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
import { SignOutButton } from "@/components/sign-out";
import { mapDbError } from "@/lib/public-error";
import { DeskScan } from "@/components/desk-scan";
import { AdminStaff } from "@/components/admin-staff";
import { VolunteerDeskMore } from "@/components/volunteer-desk-more";
import type { StaffPerson } from "@/components/staff-detail";

export default async function VolunteerPage() {
  const { userId, profile } = await getSessionProfile();
  if (!isStaff(profile?.role)) {
    redirect(roleHome(profile?.role) || "/login");
  }

  const supabase = await createClient();
  const admin = isAdmin(profile?.role);
  const teamLead = isTeamLead(profile?.role);

  if (admin) {
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

    let adminListError: string | null = null;
    if (error || teamLeadsError) {
      adminListError = mapDbError(error || teamLeadsError, {
        context: "volunteer-page.admin-list",
        fallback: "Volunteer desk data could not be loaded.",
      });
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
          {adminListError ? <ErrorBox message={adminListError} /> : null}
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
              Tap a volunteer for their KPIs and patients. The scanner lives on
              the main admin dashboard.
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

  const [{ data: camp, error: campError }, rosterResult] = await Promise.all([
    supabase
      .from("camps")
      .select("id, name, venue")
      .eq("is_active", true)
      .maybeSingle(),
    teamLead && userId
      ? supabase
          .from("profiles")
          .select("id, full_name, email, phone, role, created_at, disabled_at")
          .eq("role", "volunteer")
          .eq("team_lead_id", userId)
          .order("created_at", { ascending: false })
      : null,
  ]);

  let campErrorMsg: string | null = null;
  if (campError) {
    campErrorMsg = mapDbError(campError, {
      context: "volunteer-page.active-camp",
      fallback: "Active camp could not be loaded. Refresh to retry.",
    });
  }

  let teamVolunteers: StaffPerson[] = [];
  let rosterError: string | null = null;

  if (rosterResult) {
    if (rosterResult.error) {
      mapDbError(rosterResult.error, { context: "volunteer-page.team-roster" });
      rosterError = "Your team roster could not be loaded. Refresh and try again.";
    } else {
      teamVolunteers = rosterResult.data ?? [];
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
      ]}
    >
      <div className="space-y-3 sm:space-y-4">
        {campErrorMsg ? <ErrorBox message={campErrorMsg} /> : null}
        {rosterError ? <ErrorBox message={rosterError} /> : null}

        <Card className="bg-brand-soft !p-4 sm:!p-5">
          <p className="text-[0.6875rem] font-bold uppercase tracking-wide text-brand sm:text-xs">
            Chalu camp
          </p>
          <p className="text-lg font-bold tracking-tight sm:text-2xl">
            {camp?.name || "Koi nahi"}
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

        <DeskScan
          campId={camp?.id ?? null}
          noCampReason={
            camp
              ? undefined
              : "Koi active camp nahi. Admin se camp chalu karwayein."
          }
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
