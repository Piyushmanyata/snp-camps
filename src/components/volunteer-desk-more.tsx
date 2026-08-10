"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { OpenOnToggle, Spinner } from "@/components/ui";
import { fetchDeskSection } from "@/lib/section-client";
import type { StaffPerson } from "@/components/staff-detail";
import type { CampDayStats } from "@/lib/types";
import type { StaffKpiRow } from "@/lib/section-reads";

const TeamLeadPanel = dynamic(
  () =>
    import("@/components/team-lead-panel").then((m) => ({
      default: m.TeamLeadPanel,
    })),
  {
    ssr: false,
    loading: () => (
      <p role="status" className="py-4 text-xs text-muted">
        Loading team…
      </p>
    ),
  },
);

const SeatBoard = dynamic(
  () =>
    import("@/components/seat-board").then((m) => ({
      default: m.SeatBoard,
    })),
  {
    ssr: false,
    loading: () => (
      <p role="status" className="py-4 text-xs text-muted">
        Loading seats…
      </p>
    ),
  },
);

const VolunteerKpisSection = dynamic(
  () =>
    import("@/components/section-data").then((m) => ({
      default: m.VolunteerKpisSection,
    })),
  {
    ssr: false,
    loading: () => (
      <p role="status" className="py-4 text-xs text-muted">
        Loading points…
      </p>
    ),
  },
);

type KpisInitial =
  | {
      ok: true;
      data: {
        total: number;
        today: number;
        waiting: number;
        seen: number;
      };
    }
  | { ok: false; error: string };

function MoreIslands({
  campId,
  currentUserId,
  teamVolunteers,
  hasActiveCamp,
}: {
  campId: string | null;
  currentUserId: string;
  teamVolunteers?: StaffPerson[];
  hasActiveCamp: boolean;
}) {
  const [loading, setLoading] = useState(true);
  const [kpisInitial, setKpisInitial] = useState<KpisInitial | null>(null);
  const [days, setDays] = useState<CampDayStats[]>([]);
  const [seatsKnown, setSeatsKnown] = useState(false);
  const [leaderboard, setLeaderboard] = useState<StaffKpiRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      if (!campId) {
        if (!cancelled) {
          setKpisInitial(null);
          setDays([]);
          setSeatsKnown(true);
          setLeaderboard([]);
          setLoading(false);
        }
        return;
      }

      const [seatsRes, kpisRes, boardRes] = await Promise.all([
        fetchDeskSection<{ days: CampDayStats[] }>("seats", { campId }),
        fetchDeskSection<{
          total: number;
          today: number;
          waiting: number;
          seen: number;
        }>("volunteer-kpis", { campId }),
        fetchDeskSection<StaffKpiRow[]>("staff-leaderboard", { campId }),
      ]);

      if (cancelled) return;

      if (seatsRes.ok) {
        setDays(seatsRes.data.days ?? []);
        setSeatsKnown(true);
      } else {
        setDays([]);
        setSeatsKnown(false);
        setError(seatsRes.error);
      }

      if (kpisRes.ok) {
        setKpisInitial({ ok: true, data: kpisRes.data });
      } else {
        setKpisInitial({ ok: false, error: kpisRes.error });
      }

      if (boardRes.ok) {
        setLeaderboard(boardRes.data ?? []);
      } else {
        setLeaderboard([]);
        setError((prev) => prev ?? boardRes.error);
      }

      setLoading(false);
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [campId]);

  if (loading) {
    return (
      <p role="status" className="inline-flex items-center gap-1.5 py-4 text-xs text-muted">
        <Spinner className="h-3.5 w-3.5" />
        Loading…
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {error ? (
        <p role="status" className="text-sm text-muted">
          {error}
        </p>
      ) : null}
      {campId && kpisInitial ? (
        <div>
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">
            Active-camp KPIs
          </p>
          <VolunteerKpisSection campId={campId} initial={kpisInitial} />
        </div>
      ) : null}
      <TeamLeadPanel
        currentUserId={currentUserId}
        initialLeaderboard={leaderboard}
        teamVolunteers={teamVolunteers}
        hasActiveCamp={hasActiveCamp}
      />
      {campId ? (
        <SeatBoard
          days={days}
          campId={campId}
          title="Seat board"
          compact
          pollMs={0}
          live
          initialLoadKnown={seatsKnown}
        />
      ) : null}
    </div>
  );
}

/** Collapsed extras: points, seats, team — lazy islands + section API. */
export function VolunteerDeskMore({
  campId,
  currentUserId,
  teamVolunteers,
  hasActiveCamp,
}: {
  campId: string | null;
  currentUserId: string;
  teamVolunteers?: StaffPerson[];
  hasActiveCamp: boolean;
}) {
  return (
    <OpenOnToggle title="Aur dekhein — points, seats, team">
      {(ready) =>
        ready ? (
          <MoreIslands
            campId={campId}
            currentUserId={currentUserId}
            teamVolunteers={teamVolunteers}
            hasActiveCamp={hasActiveCamp}
          />
        ) : (
          <p role="status" className="py-4 text-xs text-muted">
            Open to load points, seats, and team…
          </p>
        )
      }
    </OpenOnToggle>
  );
}
