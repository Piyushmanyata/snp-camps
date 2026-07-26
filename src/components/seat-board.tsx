"use client";

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { POLL_MS, useFixedPoll } from "@/lib/poll";
import { useCampDeskRealtime } from "@/lib/use-camp-desk-realtime";
import { fetchDeskLive } from "@/lib/desk-live";
import { formatCampDay, type CampDayStats } from "@/lib/types";
import { ReconnectingIndicator } from "@/components/reconnecting-indicator";
import {
  Badge,
  Card,
  EmptyState,
  SectionTitle,
  Spinner,
} from "@/components/ui";

function pollHint(pollMs: number): string {
  if (pollMs <= 0) return "Tap Refresh for latest seats";
  if (pollMs < 60_000) {
    return `Updates every ${Math.round(pollMs / 1000)}s`;
  }
  return `Updates every ${Math.round(pollMs / 60_000)} min`;
}

type DaysView = {
  /** null after client fetch supersedes RSC props. */
  propsSource: CampDayStats[] | null;
  days: CampDayStats[];
};

/**
 * Seat board. Staff (`live`) uses Realtime + reconnect poll only (#26).
 * Staff catch-up uses /api/desk/live (same rule as LiveQueue, #53).
 * Patient screens keep page poll / manual refresh (`live=false`).
 */
export function SeatBoard({
  days: initialDays,
  campId = null,
  title = "Camp days & seats",
  compact = false,
  pollMs = POLL_MS,
  /** Staff desks only — patient screens keep poll-only (live=false). */
  live = false,
}: {
  days: CampDayStats[];
  campId?: string | null;
  title?: string;
  compact?: boolean;
  /** Patient auto-refresh interval; 0 = manual only. Ignored while live. */
  pollMs?: number;
  live?: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [daysState, setDaysState] = useState<DaysView | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const daysView: DaysView =
    daysState && daysState.propsSource === initialDays
      ? daysState
      : daysState && daysState.propsSource === null
        ? daysState
        : { propsSource: initialDays, days: initialDays };
  const days = daysView.days;

  const refresh = useCallback(async () => {
    if (!campId) return;
    if (live) {
      // Minimal JSON — queue + seats only; no doctor list / KPI re-fetch (#53).
      setRefreshing(true);
      try {
        const data = await fetchDeskLive(campId);
        setDaysState({ propsSource: null, days: data.days });
      } catch {
        // Failed refresh must not disable future polls.
      } finally {
        setRefreshing(false);
      }
      return;
    }
    // Patient / non-live: full page refresh (public data; no desk API session).
    startTransition(() => {
      router.refresh();
    });
  }, [campId, live, router]);

  const liveStatus = useCampDeskRealtime(
    campId,
    refresh,
    live && Boolean(campId),
  );
  const reconnecting = liveStatus === "reconnecting";
  // Live desks: poll only while reconnecting. Patient path: fixed poll when pollMs > 0.
  const pollEnabled =
    Boolean(campId) && (live ? reconnecting : pollMs > 0);
  useFixedPoll(refresh, live || reconnecting ? POLL_MS : pollMs, pollEnabled);

  const busy = live ? refreshing : isPending;

  if (!days.length) {
    return (
      <Card>
        <SectionTitle>{title}</SectionTitle>
        <ReconnectingIndicator show={reconnecting} />
        <EmptyState>
          No camp days configured yet. Admin can add days and seat limits.
        </EmptyState>
      </Card>
    );
  }

  return (
    <Card padding={compact ? "sm" : "md"}>
      <ReconnectingIndicator show={reconnecting} />
      <div className="mb-1 flex items-start justify-between gap-2">
        <SectionTitle
          hint={
            campId
              ? reconnecting
                ? "Reconnecting"
                : liveStatus === "live"
                  ? "Live"
                  : pollHint(pollMs)
              : "All days listed"
          }
        >
          {title}
        </SectionTitle>
        {campId ? (
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={busy}
            className="pressable inline-flex min-h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-[11px] font-semibold text-brand hover:bg-brand-soft disabled:opacity-50"
          >
            {busy ? <Spinner className="h-3 w-3" /> : null}
            Refresh
          </button>
        ) : null}
      </div>
      <ul
        className={
          compact
            ? "grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-2"
            : "grid gap-2 sm:grid-cols-2"
        }
      >
        {days.map((d) => {
          const pct =
            d.seat_limit > 0
              ? Math.min(100, Math.round((d.seats_taken / d.seat_limit) * 100))
              : 100;
          return (
            <li
              key={d.id}
              className={`rounded-xl border p-3 transition-colors ${
                d.is_full
                  ? "border-amber-200/80 bg-amber-50/40"
                  : "border-border bg-background/50"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold tracking-tight text-foreground">
                    {formatCampDay(d.day_date)}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    <span className="tabular font-medium text-foreground/80">
                      {d.seats_taken}
                    </span>{" "}
                    taken ·{" "}
                    <span className="tabular font-medium text-foreground/80">
                      {d.seats_left}
                    </span>{" "}
                    left · {d.seat_limit} total
                  </p>
                </div>
                <Badge tone={d.is_full ? "wait" : "ok"}>
                  {d.is_full ? "Full" : "Open"}
                </Badge>
              </div>
              <div
                className="mt-2.5 h-2 overflow-hidden rounded-full bg-border/80"
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${pct}% of seats taken`}
              >
                <div
                  className={`h-full rounded-full transition-[width] duration-300 ${
                    d.is_full ? "bg-amber-500" : "bg-brand"
                  }`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
