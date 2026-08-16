import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile, isTeamLead, isAdmin, roleHome } from "@/lib/auth";
import {
  Card,
  ErrorBox,
  NavLink,
  Shell,
} from "@/components/ui";
import { SignOutButton } from "@/components/sign-out";
import { mapDbError } from "@/lib/public-error";
import { AdminStaff } from "@/components/admin-staff";
import { TeamAssignments } from "@/components/team-assignments";

export default async function TeamLeadPage() {
  const { userId, profile } = await getSessionProfile();
  if (!userId) redirect("/login");
  if (!isTeamLead(profile?.role) && !isAdmin(profile?.role)) {
    redirect(roleHome(profile?.role) || "/login");
  }

  if (isTeamLead(profile?.role)) redirect("/volunteer");

  const supabase = await createClient();
  const [
    { data: teamLeadsFull, error },
    { data: volunteers, error: volunteersError },
  ] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, full_name, email, phone, role, created_at, disabled_at, team_lead_id")
      .eq("role", "team_lead")
      .order("created_at", { ascending: false }),
    supabase
      .from("profiles")
      .select("id, full_name, email, team_lead_id")
      .eq("role", "volunteer")
      .is("disabled_at", null)
      .order("full_name", { ascending: true }),
  ]);

  let loadError: string | null = null;
  if (error) {
    loadError = mapDbError(error, {
      context: "team-lead-page.admin-list",
      fallback: "Team lead desk data could not be loaded.",
    });
  }
  const activeTeamLeads = teamLeadsFull?.filter((tl) => !tl.disabled_at).length ?? 0;
  const disabledTeamLeads = (teamLeadsFull?.length ?? 0) - activeTeamLeads;

  let assignmentsError: string | null = null;
  if (volunteersError) {
    assignmentsError = mapDbError(volunteersError, {
      context: "team-lead-page.assignments",
      fallback: "Team assignments could not be loaded.",
    });
  }
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
        {loadError ? <ErrorBox message={loadError} /> : null}
        {assignmentsError ? <ErrorBox message={assignmentsError} /> : null}
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
        <Card>
          <h2 className="text-base font-bold text-foreground">Team assignments</h2>
          <div className="mt-3">
            <TeamAssignments
              teamLeads={(teamLeadsFull ?? []).filter((lead) => !lead.disabled_at)}
              volunteers={volunteers ?? []}
            />
          </div>
        </Card>
      </div>
    </Shell>
  );
}
