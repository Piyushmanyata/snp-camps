"use client";

import { useState, useTransition } from "react";
import { Card, SectionTitle, Button, Input, ErrorBox, SuccessBox } from "@/components/ui";

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
}: {
  currentUserId: string;
  initialLeaderboard: StaffKpiRow[];
}) {
  const leaderboard = initialLeaderboard;
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const teamLeads = leaderboard.filter((r) => r.role === "team_lead" || r.role === "admin");
  const volunteers = leaderboard.filter((r) => r.role === "volunteer");

  const myTeamLeadRow = leaderboard.find((r) => r.staff_id === currentUserId);
  const myTeamVolunteers = volunteers.filter((v) => v.team_lead_id === currentUserId);

  async function handleCreateVolunteer(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    startTransition(async () => {
      try {
        const res = await fetch("/api/team-lead/create-volunteer", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, fullName, teamLeadId: currentUserId }),
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          setSuccess(`Volunteer "${fullName}" created and added to your team!`);
          setEmail("");
          setFullName("");
        } else {
          setError(data.error || "Failed to create volunteer.");
        }
      } catch {
        setError("Network error creating volunteer.");
      }
    });
  }

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
              {myTeamVolunteers.length}
            </p>
          </div>
        </div>
      </Card>

      {/* Add Volunteer to Team */}
      <Card className="!p-4 sm:!p-5">
        <SectionTitle hint="Add a new volunteer to your team">
          Create Team Volunteer
        </SectionTitle>
        <form onSubmit={handleCreateVolunteer} className="space-y-3 mt-2">
          <ErrorBox message={error} />
          <SuccessBox message={success} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              id="new-vol-name"
              label="Volunteer Full Name *"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="e.g. Rahul Sharma"
            />
            <Input
              id="new-vol-email"
              label="Email Address *"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="e.g. rahul@example.com"
            />
          </div>
          <Button type="submit" variant="primary" loading={isPending} className="w-full sm:w-auto">
            + Add Volunteer to My Team
          </Button>
        </form>
      </Card>

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
