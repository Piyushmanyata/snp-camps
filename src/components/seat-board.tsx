import { formatCampDay, type CampDayStats } from "@/lib/types";
import { Badge, Card, EmptyState, SectionTitle } from "@/components/ui";

export function SeatBoard({
  days,
  title = "Camp days & seats",
  compact = false,
}: {
  days: CampDayStats[];
  title?: string;
  compact?: boolean;
}) {
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
      <SectionTitle hint="All days listed">{title}</SectionTitle>
      <ul
        className={
          compact
            ? "grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
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
