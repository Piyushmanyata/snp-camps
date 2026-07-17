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
      <SectionTitle hint="All days stay listed">
        {title}
      </SectionTitle>
      <ul className="space-y-2">
        {days.map((d) => {
          const pct =
            d.seat_limit > 0
              ? Math.min(100, Math.round((d.seats_taken / d.seat_limit) * 100))
              : 100;
          return (
            <li
              key={d.id}
              className="rounded-xl border border-border bg-background/50 p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold tracking-tight">
                    {formatCampDay(d.day_date)}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    {d.seats_taken} taken · {d.seats_left} left · {d.seat_limit}{" "}
                    total
                  </p>
                </div>
                <Badge tone={d.is_full ? "wait" : "ok"}>
                  {d.is_full ? "Full" : "Open"}
                </Badge>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-border/80">
                <div
                  className={`h-full rounded-full transition-all ${
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
