"use client";

import { useCallback, useTransition } from "react";
import { useRouter } from "next/navigation";
import { POLL_MS, useFixedPoll } from "@/lib/poll";
import { useCampDeskLive } from "@/lib/use-camp-desk-live";
import { formatCampDay, type CampDayStats } from "@/lib/types";
import { DeskFreshnessIndicator } from "@/components/desk-freshness-indicator";
import {
  Badge,
  Card,
  EmptyState,
  ErrorBox,
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

export function SeatBoard({
  days: initialDays,
  campId = null,
  title = "Camp days & seats",
  compact = false,
  pollMs = POLL_MS,
  live = false,
  // False when SSR seats failed — do not treat empty as success (#63).
  initialLoadKnown = true,
}: {
  days: CampDayStats[];
  campId?: string | null;
  title?: string;
  compact?: boolean;
  pollMs?: number;
  live?: boolean;
  initialLoadKnown?: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const desk = useCampDeskLive(live ? campId : null, {
    days: initialDays,
    daysKnown: initialLoadKnown,
  });

  const patientRefresh = useCallback(() => {
    startTransition(() => {
      router.refresh();
    });
  }, [router]);

  useFixedPoll(
    patientRefresh,
    pollMs,
    Boolean(campId) && !live && pollMs > 0,
  );

  const days = live && campId ? desk.days : initialDays;
  const busy = live ? desk.refreshing : isPending;
  const freshness = live ? desk.freshness : "off";
  const daysKnown = live && campId ? desk.daysKnown : true;

  const hint = !campId
    ? "All days listed"
    : live
      ? freshness === "stale-error"
        ? "Stale"
        : freshness === "error"
          ? "Unavailable"
          : freshness === "refreshing"
            ? "Refreshing"
            : "Live"
      : pollHint(pollMs);

  function onRefresh() {
    if (live) {
      desk.refresh();
      return;
    }
    patientRefresh();
  }

  const seatsFailed =
    live &&
    !daysKnown &&
    (freshness === "error" || freshness === "stale-error");

  if (!days.length) {
    return (
      <Card>
        <SectionTitle hint={live ? hint : undefined}>{title}</SectionTitle>
        {live ? (
          <DeskFreshnessIndicator
            freshness={freshness}
            onRetry={() => desk.refresh()}
            hasKnownData={daysKnown}
          />
        ) : null}
        {seatsFailed ? (
          <ErrorBox message="Seat board could not be loaded. Use Refresh or Try again — this is not an empty schedule." />
        ) : (
          <EmptyState>
            No camp days configured yet. Admin can add days and seat limits.
          </EmptyState>
        )}
      </Card>
    );
  }

  return (
    <Card padding={compact ? "sm" : "md"}>
      {live ? (
        <DeskFreshnessIndicator
          freshness={freshness}
          onRetry={() => desk.refresh()}
          hasKnownData={daysKnown}
        />
      ) : null}
      <div className="mb-1 flex items-start justify-between gap-2">
        <SectionTitle hint={hint}>{title}</SectionTitle>
        {campId ? (
          <button
            type="button"
            onClick={onRefresh}
            disabled={busy}
            className="pressable inline-flex min-h-12 min-w-12 shrink-0 items-center justify-center gap-1 rounded-lg px-3 text-sm font-semibold text-brand hover:bg-brand-soft disabled:opacity-50"
          >
            {busy ? <Spinner className="h-3 w-3" /> : null}
            Refresh
          </button>
        ) : null}
      </div>
      <ul
        className={
          compact
            ? // min() keeps auto-fit from forcing horizontal overflow at 200% text (#69)
              "grid grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] gap-2"
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
                  ? "border-warning/30 bg-warning-soft"
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
                    d.is_full ? "bg-warning" : "bg-brand"
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
