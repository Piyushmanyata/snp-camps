"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatCampDay, type CampDayStats } from "@/lib/types";
import { Badge, Card, EmptyState, SectionTitle, Spinner } from "@/components/ui";

/** Seat board — seats count patients at registration. Polls when campId set. */
export function SeatBoard({
  days: initialDays,
  campId = null,
  title = "Camp days & seats",
  compact = false,
  pollMs = 12_000,
}: {
  days: CampDayStats[];
  /** When set, board polls camp_day_stats live (seat taken on register). */
  campId?: string | null;
  title?: string;
  compact?: boolean;
  pollMs?: number;
}) {
  const [days, setDays] = useState(initialDays);
  const [serverDays, setServerDays] = useState(initialDays);
  const [refreshing, setRefreshing] = useState(false);

  if (initialDays !== serverDays) {
    setServerDays(initialDays);
    setDays(initialDays);
  }

  const refresh = useCallback(async () => {
    if (!campId) return true;
    setRefreshing(true);
    const supabase = createClient();
    const { data, error } = await supabase.rpc("camp_day_stats", {
      p_camp_id: campId,
    });
    setRefreshing(false);
    if (error) return false;
    setDays((data as CampDayStats[]) || []);
    return true;
  }, [campId]);

  useEffect(() => {
    if (!campId || pollMs <= 0) return;
    let cancelled = false;
    let timer = 0;
    let delay = pollMs + Math.floor(Math.random() * 2_000);

    const schedule = () => {
      timer = window.setTimeout(async () => {
        if (cancelled) return;
        const ok =
          document.visibilityState !== "visible" || (await refresh());
        delay = ok ? pollMs : Math.min(60_000, Math.max(pollMs, delay * 2));
        schedule();
      }, delay);
    };
    schedule();

    const onVis = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [campId, pollMs, refresh]);

  if (!days.length) {
    return (
      <Card>
        <SectionTitle>{title}</SectionTitle>
        <EmptyState>
          No camp days configured yet. Admin can add days and seat limits.
        </EmptyState>
      </Card>
    );
  }

  return (
    <Card padding={compact ? "sm" : "md"}>
      <div className="mb-1 flex items-start justify-between gap-2">
        <SectionTitle
          hint={campId ? "Live · seat taken on register" : "All days listed"}
        >
          {title}
        </SectionTitle>
        {campId ? (
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            className="pressable inline-flex min-h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-[11px] font-semibold text-brand hover:bg-brand-soft disabled:opacity-50"
          >
            {refreshing ? <Spinner className="h-3 w-3" /> : null}
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
