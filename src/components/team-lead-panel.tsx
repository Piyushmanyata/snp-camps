"use client";

import { Card, SectionTitle } from "@/components/ui";
import { AdminStaff } from "@/components/admin-staff";
import type { StaffPerson } from "@/components/staff-detail";

type StaffKpiRow = {
  staff_id: string;
  full_name: string;
  role: string;
  distinct_patients: number;
  registered_count: number;
  seen_count: number;
  metric_label: string;
  team_lead_id: string | null;
  team_headcount: number;
};

export function TeamLeadPanel({
  currentUserId,
  initialLeaderboard,
  teamVolunteers,
  hasActiveCamp,
}: {
  currentUserId: string;
  initialLeaderboard: StaffKpiRow[];
  teamVolunteers?: StaffPerson[];
  hasActiveCamp: boolean;
}) {
  const leaderboard = initialLeaderboard;

  const teamLeads = leaderboard.filter((r) => r.role === "team_lead");
  const volunteers = leaderboard.filter((r) => r.role === "volunteer");

  const myTeamLeadRow = leaderboard.find((r) => r.staff_id === currentUserId);
  const activeTeamSize = teamVolunteers
    ? teamVolunteers.filter((v) => !v.disabled_at).length
    : volunteers.filter((v) => v.team_lead_id === currentUserId).length;
  const teamMetricById = Object.fromEntries(
    volunteers
      .filter((volunteer) => volunteer.team_lead_id === currentUserId)
      .map((volunteer) => [volunteer.staff_id, volunteer.distinct_patients]),
  );
  const isTeamLeadView = teamVolunteers !== undefined;

  return (
    <div className="space-y-4">
      {isTeamLeadView ? (
        <Card className="bg-brand-soft border-2 border-brand/20 !p-4 sm:!p-5">
        <SectionTitle hint="Live team summary">
          Team lead summary
        </SectionTitle>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-2">
          <div className="rounded-xl border border-brand/20 bg-card p-3">
            <p className="text-[0.8125rem] font-semibold uppercase text-muted">Distinct patients</p>
            <p className="text-2xl font-extrabold text-brand tabular mt-1">
              {myTeamLeadRow?.distinct_patients ?? 0}
            </p>
          </div>
          <div className="rounded-xl border border-brand/20 bg-card p-3">
            <p className="text-[0.8125rem] font-semibold uppercase text-muted">Team size</p>
            <p className="text-2xl font-extrabold text-foreground tabular mt-1">
              {activeTeamSize}
            </p>
          </div>
        </div>
        {!hasActiveCamp ? (
          <p className="mt-3 text-sm text-muted" role="status">
            No active camp — count remains zero. This is not a career total.
          </p>
        ) : null}
        </Card>
      ) : null}

      {teamVolunteers ? (
        <Card className="!p-4 sm:!p-5">
          <SectionTitle hint="Add · reset password · disable">
            My team volunteers
          </SectionTitle>
          <div className="mt-2">
            <AdminStaff
              role="volunteer"
              initial={teamVolunteers}
              canManage
              canViewDetail={false}
              metricById={teamMetricById}
            />
          </div>
        </Card>
      ) : null}

      {hasActiveCamp ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="!p-4">
          <h3 className="text-sm font-bold uppercase tracking-wider text-muted mb-3">
            Team Lead leaderboard · outcomes
          </h3>
          {teamLeads.length === 0 ? (
            <p className="text-[0.8125rem] text-muted">
              No team leads recorded.
            </p>
          ) : (
            <div className="space-y-2">
              {teamLeads.map((tl, rank) => (
                <div
                  key={tl.staff_id}
                  className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 p-3 rounded-xl border ${
                    tl.staff_id === currentUserId
                      ? "border-brand bg-brand-soft font-bold text-brand"
                      : "border-border bg-card text-foreground"
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="w-6 text-center text-[0.8125rem] font-bold text-muted">
                      #{rank + 1}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold">{tl.full_name}</p>
                      <p className="text-[0.8125rem] text-muted">
                        {tl.team_headcount} volunteers
                      </p>
                    </div>
                  </div>
                  <span className="text-right font-extrabold leading-tight tabular">
                    <span className="block text-base">{tl.distinct_patients}</span>
                    <span className="block text-[0.8125rem]">
                      {tl.metric_label || "distinct patients"}
                    </span>
                    <span className="block text-[0.8125rem] font-medium text-muted">
                      Registered {tl.registered_count} · Seen {tl.seen_count}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="!p-4">
          <h3 className="text-sm font-bold uppercase tracking-wider text-muted mb-3">
            Volunteer leaderboard · outcomes
          </h3>
          {volunteers.length === 0 ? (
            <p className="text-[0.8125rem] text-muted">
              No volunteers recorded.
            </p>
          ) : (
            <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
              {volunteers.map((vol, rank) => (
                <div
                  key={vol.staff_id}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-xl border border-border bg-card p-3 text-foreground"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="w-6 text-center text-[0.8125rem] font-bold text-muted">
                      #{rank + 1}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold">{vol.full_name}</p>
                    </div>
                  </div>
                  <span className="text-right font-extrabold leading-tight tabular text-brand">
                    <span className="block text-base">{vol.distinct_patients}</span>
                    <span className="block text-[0.8125rem]">
                      {vol.metric_label || "distinct patients"}
                    </span>
                    <span className="block text-[0.8125rem] font-medium text-muted">
                      Registered {vol.registered_count} · Seen {vol.seen_count}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
        </div>
      ) : null}
    </div>
  );
}
