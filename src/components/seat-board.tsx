"use client";

import { useCallback, useTransition } from "react";
import { useRouter } from "next/navigation";
import { POLL_MS, useFixedPoll } from "@/lib/poll";
import { useCampDeskRealtime } from "@/lib/use-camp-desk-realtime";
import { formatCampDay, type CampDayStats } from "@/lib/types";
import { ReconnectingIndicator } from "@/components/reconnecting-indicator";
import {
  Badge,
  Card,
  EmptyState,
  SectionTitle,
  Spinner,
} from "@/components/ui";

/**
 * Seat board. Staff (`live`) uses Realtime + reconnect poll only.
 * Patient screens keep fixed poll (`live=false`, default pollMs 2 min).
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
  const refresh = useCallback(() => {
    if (!campId) return;
    startTransition(() => {
      router.refresh();
    });
  }, [campId, router]);

  const days = initialDays;

  const liveStatus = useCampDeskRealtime(
    campId,
    refresh,
    live && Boolean(campId),
  );
  const reconnecting = liveStatus === "reconnecting";
  // Live desks: poll only while reconnecting. Patient path: unchanged fixed poll.
  const pollEnabled =
    Boolean(campId) && (live ? reconnecting : pollMs > 0);
  useFixedPoll(refresh, live || reconnecting ? POLL_MS : pollMs, pollEnabled);

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
                  : pollMs > 0
                    ? `Updates every ${Math.round(pollMs / 60_000)} min`
                    : "Tap Refresh for latest seats"
              : "All days listed"
          }
        >
          {title}
        </SectionTitle>
        {campId ? (
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={isPending}
            className="pressable inline-flex min-h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-[11px] font-semibold text-brand hover:bg-brand-soft disabled:opacity-50"
          >
            {isPending ? <Spinner className="h-3 w-3" /> : null}
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
