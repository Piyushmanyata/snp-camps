import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile, isTeamLead, isAdmin, roleHome } from "@/lib/auth";
import {
  Card,
  NavLink,
  Shell,
} from "@/components/ui";
import { SignOutButton } from "@/components/sign-out";
import { mapDbError } from "@/lib/public-error";
import { AdminStaff } from "@/components/admin-staff";
import { TeamLeadPanel } from "@/components/team-lead-panel";
import { loadStaffLeaderboardSection, type StaffKpiRow } from "@/lib/section-reads";

export default async function TeamLeadPage() {
  const { userId, profile } = await getSessionProfile();
  if (!userId) redirect("/login");
  if (!isTeamLead(profile?.role) && !isAdmin(profile?.role)) {
    redirect(roleHome(profile?.role) || "/login");
  }

  const supabase = await createClient();
  const admin = isAdmin(profile?.role);

  if (admin) {
    const { data: teamLeadsFull, error } = await supabase
      .from("profiles")
      .select("id, full_name, email, phone, role, created_at, disabled_at")
      .eq("role", "team_lead")
      .order("created_at", { ascending: false });

    if (error) {
      mapDbError(error, { context: "team-lead-page.admin-list" });
      throw new Error("Team lead desk data could not be loaded");
    }
    const activeTeamLeads = teamLeadsFull?.filter((tl) => !tl.disabled_at).length ?? 0;
    const disabledTeamLeads = (teamLeadsFull?.length ?? 0) - activeTeamLeads;

    return (
      <Shell
        title="Team Lead desk"
        subtitle="Manage team leads · KPIs · account access"
        width="xl"
        roleLabel="Admin"
        actions={<SignOutButton place="header" />}
        dock={[
          { href: "/admin", label: "Admin" },
          { href: "/register", label: "Register", primary: true },
          { href: "/admin/patients", label: "Patients" },
        ]}
      >
        <div className="space-y-4">
          <Card className="bg-brand-soft">
            <p className="text-xs font-bold uppercase tracking-wide text-brand">
              Staff management
            </p>
            <p className="text-xl font-bold tracking-tight">
              {activeTeamLeads} active team lead{activeTeamLeads === 1 ? "" : "s"}
            </p>
            <p className="mt-1 text-sm text-muted">
              {disabledTeamLeads ? `${disabledTeamLeads} disabled · ` : ""}
              Tap a team lead for their KPIs and patient rollup.
            </p>
            <div className="desk-inline-actions mt-4">
              <NavLink href="/admin" variant="soft">
                Back to admin
              </NavLink>
            </div>
          </Card>
          <Card>
            <AdminStaff role="team_lead" initial={teamLeadsFull || []} canManage />
          </Card>
        </div>
      </Shell>
    );
  }

  const { data: camp } = await supabase
    .from("camps")
    .select("id, name, venue")
    .eq("is_active", true)
    .maybeSingle();

  let leaderboard: StaffKpiRow[] = [];
  if (camp && userId) {
    const leaderboardRes = await loadStaffLeaderboardSection(camp.id);
    if (leaderboardRes.ok) leaderboard = leaderboardRes.data;
  }

  return (
    <Shell
      title="Team Lead desk"
      subtitle={profile?.full_name ? `${profile.full_name} · Team Lead` : "Team Lead"}
      width="xl"
      roleLabel="Team Lead"
      actions={<SignOutButton place="header" />}
      dock={[
        { href: "/volunteer", label: "Desk", primary: true },
        { href: "/register", label: "Register" },
        { href: "/counter", label: "Counter" },
      ]}
    >
      <div className="space-y-4">
        <TeamLeadPanel currentUserId={userId} initialLeaderboard={leaderboard} />
      </div>
    </Shell>
  );
}
