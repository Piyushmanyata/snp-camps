"use client";

import { useState } from "react";
import { ErrorBox, SuccessBox } from "@/components/ui";

type TeamLeadOption = {
  id: string;
  full_name: string | null;
};

type VolunteerAssignment = {
  id: string;
  full_name: string | null;
  email: string | null;
  team_lead_id?: string | null;
};

export function TeamAssignments({
  teamLeads,
  volunteers: initialVolunteers,
}: {
  teamLeads: TeamLeadOption[];
  volunteers: VolunteerAssignment[];
}) {
  const [volunteers, setVolunteers] = useState(initialVolunteers);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function assign(volunteer: VolunteerAssignment, teamLeadId: string | null) {
    if (savingId) return;
    const previous = volunteer.team_lead_id ?? null;
    setSavingId(volunteer.id);
    setError(null);
    setSuccess(null);
    setVolunteers((rows) =>
      rows.map((row) =>
        row.id === volunteer.id ? { ...row, team_lead_id: teamLeadId } : row,
      ),
    );

    try {
      const response = await fetch("/api/admin/team-assignments", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ volunteerId: volunteer.id, teamLeadId }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        setVolunteers((rows) =>
          rows.map((row) =>
            row.id === volunteer.id ? { ...row, team_lead_id: previous } : row,
          ),
        );
        setError(body.error || "Team assignment could not be saved.");
        return;
      }
      setSuccess(
        teamLeadId
          ? `${volunteer.full_name || "Volunteer"} moved to the selected team.`
          : `${volunteer.full_name || "Volunteer"} is now unassigned.`,
      );
    } catch {
      setVolunteers((rows) =>
        rows.map((row) =>
          row.id === volunteer.id ? { ...row, team_lead_id: previous } : row,
        ),
      );
      setError("Network error. Check the connection and try again.");
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Assign, move, or unassign active volunteers. A volunteer belongs to at
        most one active Team Lead.
      </p>
      <ErrorBox message={error} />
      <SuccessBox message={success} />
      <ul className="divide-y divide-border rounded-xl border border-border bg-white">
        {volunteers.map((volunteer) => (
          <li
            key={volunteer.id}
            className="grid gap-2 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(14rem,20rem)] sm:items-center"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">
                {volunteer.full_name || "Unnamed volunteer"}
              </p>
              <p className="truncate text-xs text-muted">
                {volunteer.email || "No email"}
              </p>
            </div>
            <label className="grid gap-1 text-xs font-semibold text-muted">
              <span className="sr-only">
                Team Lead for {volunteer.full_name || "volunteer"}
              </span>
              <select
                value={volunteer.team_lead_id ?? ""}
                disabled={savingId !== null}
                aria-busy={savingId === volunteer.id || undefined}
                onChange={(event) =>
                  void assign(volunteer, event.target.value || null)
                }
                className="min-h-12 rounded-xl border border-border bg-white px-3 text-sm text-foreground disabled:opacity-60"
              >
                <option value="">Unassigned</option>
                {teamLeads.map((lead) => (
                  <option key={lead.id} value={lead.id}>
                    {lead.full_name || "Unnamed Team Lead"}
                  </option>
                ))}
              </select>
            </label>
          </li>
        ))}
        {!volunteers.length ? (
          <li className="px-3 py-4 text-sm text-muted">
            No active volunteers to assign.
          </li>
        ) : null}
      </ul>
    </div>
  );
}
