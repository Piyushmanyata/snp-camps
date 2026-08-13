"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { Spinner } from "@/components/ui";
import { OpenOnToggle } from "@/components/open-on-toggle";
import { SectionLoadError } from "@/components/section-load-error";
import { fetchDeskSection } from "@/lib/section-client";
import type { StaffPerson } from "@/components/staff-detail";
import type { CampDayStats } from "@/lib/types";
import type { StaffKpiRow } from "@/lib/section-reads";

const SECTION_FAIL = "Ye hissa load nahi hua.";
const SECTION_RETRY = "Dobara koshish karein";

const TeamLeadPanel = dynamic(
  () =>
    import("@/components/team-lead-panel").then((m) => ({
      default: m.TeamLeadPanel,
    })),
  {
    ssr: false,
    loading: () => (
      <p role="status" className="py-4 text-xs text-muted">
        Team load ho rahi hai…
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
        Seats load ho rahi hain…
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
        Points load ho rahe hain…
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
  const [seatsError, setSeatsError] = useState<string | null>(null);
  const [kpisError, setKpisError] = useState<string | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);

  const loadSeats = useCallback(async () => {
    if (!campId) {
      setDays([]);
      setSeatsKnown(true);
      setSeatsError(null);
      return;
    }
    const seatsRes = await fetchDeskSection<{ days: CampDayStats[] }>("seats", {
      campId,
    });
    if (seatsRes.ok) {
      setDays(seatsRes.data.days ?? []);
      setSeatsKnown(true);
      setSeatsError(null);
    } else {
      setDays([]);
      setSeatsKnown(false);
      setSeatsError(seatsRes.error || SECTION_FAIL);
    }
  }, [campId]);

  const loadKpis = useCallback(async () => {
    if (!campId) {
      setKpisInitial(null);
      setKpisError(null);
      return;
    }
    const kpisRes = await fetchDeskSection<{
      total: number;
      today: number;
      seen: number;
    }>("volunteer-kpis", { campId });
    if (kpisRes.ok) {
      setKpisInitial({ ok: true, data: kpisRes.data });
      setKpisError(null);
    } else {
      setKpisInitial(null);
      setKpisError(kpisRes.error || SECTION_FAIL);
    }
  }, [campId]);

  const loadBoard = useCallback(async () => {
    if (!campId) {
      setLeaderboard([]);
      setBoardError(null);
      return;
    }
    const boardRes = await fetchDeskSection<StaffKpiRow[]>(
      "staff-leaderboard",
      { campId },
    );
    if (boardRes.ok) {
      setLeaderboard(boardRes.data ?? []);
      setBoardError(null);
    } else {
      setLeaderboard([]);
      setBoardError(boardRes.error || SECTION_FAIL);
    }
  }, [campId]);

  useEffect(() => {
    let cancelled = false;

    async function loadAll() {
      setLoading(true);
      setSeatsError(null);
      setKpisError(null);
      setBoardError(null);

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

      await Promise.all([loadSeats(), loadKpis(), loadBoard()]);
      if (!cancelled) setLoading(false);
    }

    void loadAll();
    return () => {
      cancelled = true;
    };
  }, [campId, loadSeats, loadKpis, loadBoard]);

  if (loading) {
    return (
      <p role="status" className="inline-flex items-center gap-1.5 py-4 text-xs text-muted">
        <Spinner className="h-3.5 w-3.5" />
        Load ho raha hai…
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {campId ? (
        <div>
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">
            Aaj ke camp ke numbers
          </p>
          {kpisError ? (
            <SectionLoadError
              message={SECTION_FAIL}
              onRetry={loadKpis}
              retryLabel={SECTION_RETRY}
            />
          ) : kpisInitial ? (
            <VolunteerKpisSection campId={campId} initial={kpisInitial} />
          ) : null}
        </div>
      ) : null}
      <div>
        {boardError ? (
          <SectionLoadError
            message={SECTION_FAIL}
            onRetry={loadBoard}
            retryLabel={SECTION_RETRY}
          />
        ) : (
          <TeamLeadPanel
            currentUserId={currentUserId}
            initialLeaderboard={leaderboard}
            teamVolunteers={teamVolunteers}
            hasActiveCamp={hasActiveCamp}
          />
        )}
      </div>
      {campId ? (
        <div>
          {seatsError ? (
            <SectionLoadError
              message={SECTION_FAIL}
              onRetry={loadSeats}
              retryLabel={SECTION_RETRY}
            />
          ) : (
            <SeatBoard
              days={days}
              campId={campId}
              title="Seat board"
              compact
              pollMs={0}
              live
              initialLoadKnown={seatsKnown}
            />
          )}
        </div>
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
            Points, seats, team load karne ke liye kholen…
          </p>
        )
      }
    </OpenOnToggle>
  );
}
