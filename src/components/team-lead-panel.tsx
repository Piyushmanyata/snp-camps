"use client";

import { Card, SectionTitle } from "@/components/ui";
import { AdminStaff } from "@/components/admin-staff";
import type { StaffPerson } from "@/components/staff-detail";

type StaffKpiRow = {
  staff_id: string;
  full_name: string;
  role: string;
  distinct_patients: number;
  team_lead_id: string | null;
  team_headcount: number;
};

export function TeamLeadPanel({
  currentUserId,
  initialLeaderboard,
  teamVolunteers,
}: {
  currentUserId: string;
  initialLeaderboard: StaffKpiRow[];
  /**
   * The caller's own team, for the add/manage roster. Omitted by the admin
   * dashboard, which manages every volunteer on the volunteer desk instead —
   * the roster card is then not rendered at all.
   */
  teamVolunteers?: StaffPerson[];
}) {
  const leaderboard = initialLeaderboard;

  const teamLeads = leaderboard.filter((r) => r.role === "team_lead" || r.role === "admin");
  const volunteers = leaderboard.filter((r) => r.role === "volunteer");

  const myTeamLeadRow = leaderboard.find((r) => r.staff_id === currentUserId);
  // Headcount comes from the roster, not the leaderboard: the leaderboard only
  // carries staff who have handled a patient at this camp, so counting it hid
  // every volunteer who had not registered anyone yet.
  const activeTeamSize = teamVolunteers
    ? teamVolunteers.filter((v) => !v.disabled_at).length
    : volunteers.filter((v) => v.team_lead_id === currentUserId).length;

  return (
    <div className="space-y-4">
      {/* Team Summary Card */}
      <Card className="bg-brand-soft border-2 border-brand/20 !p-4 sm:!p-5">
        <SectionTitle hint="Your team's live rollup">
          Team Lead Overview
        </SectionTitle>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-2">
          <div className="rounded-xl border border-brand/20 bg-card p-3">
            <p className="text-xs font-semibold text-muted uppercase">Team Patients Handled</p>
            <p className="text-2xl font-extrabold text-brand tabular mt-1">
              {myTeamLeadRow?.distinct_patients ?? 0}
            </p>
          </div>
          <div className="rounded-xl border border-brand/20 bg-card p-3">
            <p className="text-xs font-semibold text-muted uppercase">Team Headcount</p>
            <p className="text-2xl font-extrabold text-foreground tabular mt-1">
              {activeTeamSize}
            </p>
          </div>
        </div>
      </Card>

      {teamVolunteers ? (
        /* Add and manage the volunteers on this team. Same component the admin
           uses; the staff API scopes every read and write to the caller's team. */
        <Card className="!p-4 sm:!p-5">
          <SectionTitle hint="Add · reset password · deactivate">
            My team&apos;s volunteers
          </SectionTitle>
          <div className="mt-2">
            <AdminStaff
              role="volunteer"
              initial={teamVolunteers}
              canManage
              canViewDetail={false}
            />
          </div>
        </Card>
      ) : null}

      {/* Two Leaderboards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* 1. Team Lead Leaderboard */}
        <Card className="!p-4">
          <h3 className="text-sm font-bold uppercase tracking-wider text-muted mb-3">
            🏆 Team Lead Leaderboard
          </h3>
          {teamLeads.length === 0 ? (
            <p className="text-xs text-muted">No team leads recorded.</p>
          ) : (
            <div className="space-y-2">
              {teamLeads.map((tl, rank) => (
                <div
                  key={tl.staff_id}
                  className={`flex items-center justify-between p-3 rounded-xl border ${
                    tl.staff_id === currentUserId
                      ? "border-brand bg-brand-soft font-bold text-brand"
                      : "border-border bg-card text-foreground"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="w-6 text-center text-xs font-bold text-muted">
                      #{rank + 1}
                    </span>
                    <div>
                      <p className="text-sm font-bold">{tl.full_name}</p>
                      <p className="text-[11px] text-muted">{tl.team_headcount} volunteers</p>
                    </div>
                  </div>
                  <span className="text-base font-extrabold tabular">{tl.distinct_patients} patients</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* 2. Volunteer Leaderboard */}
        <Card className="!p-4">
          <h3 className="text-sm font-bold uppercase tracking-wider text-muted mb-3">
            ⭐ Volunteer Leaderboard
          </h3>
          {volunteers.length === 0 ? (
            <p className="text-xs text-muted">No volunteers recorded.</p>
          ) : (
            <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
              {volunteers.map((vol, rank) => (
                <div
                  key={vol.staff_id}
                  className="flex items-center justify-between p-3 rounded-xl border border-border bg-card text-foreground"
                >
                  <div className="flex items-center gap-2">
                    <span className="w-6 text-center text-xs font-bold text-muted">
                      #{rank + 1}
                    </span>
                    <div>
                      <p className="text-sm font-bold">{vol.full_name}</p>
                    </div>
                  </div>
                  <span className="text-base font-extrabold tabular text-brand">{vol.distinct_patients} patients</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
