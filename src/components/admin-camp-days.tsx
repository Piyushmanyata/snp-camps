"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatCampDay, type CampDayStats } from "@/lib/types";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBox,
  Input,
  SectionTitle,
} from "@/components/ui";

export function AdminCampDays({
  campId,
  campName,
  initialDays,
}: {
  campId: string;
  campName: string;
  initialDays: CampDayStats[];
}) {
  const router = useRouter();
  const [days, setDays] = useState(initialDays);
  const [dayDate, setDayDate] = useState("");
  const [seats, setSeats] = useState("100");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Record<string, string>>({});

  async function refresh() {
    const supabase = createClient();
    const { data } = await supabase.rpc("camp_day_stats", {
      p_camp_id: campId,
    });
    setDays((data as CampDayStats[]) || []);
    router.refresh();
  }

  async function addDay(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const limit = Number(seats);
    if (!dayDate || Number.isNaN(limit) || limit < 0) {
      setError("Enter a date and seat limit ≥ 0");
      setLoading(false);
      return;
    }
    const supabase = createClient();
    const { error: err } = await supabase.rpc("upsert_camp_day", {
      p_camp_id: campId,
      p_day_date: dayDate,
      p_seat_limit: limit,
      p_day_id: null,
    });
    if (err) setError(err.message);
    else {
      setDayDate("");
      setSeats("100");
      await refresh();
    }
    setLoading(false);
  }

  async function saveSeats(dayId: string, dayDateIso: string) {
    setError(null);
    const limit = Number(editing[dayId] ?? "");
    if (Number.isNaN(limit) || limit < 0) {
      setError("Seat limit must be ≥ 0");
      return;
    }
    const supabase = createClient();
    const { error: err } = await supabase.rpc("upsert_camp_day", {
      p_camp_id: campId,
      p_day_date: dayDateIso,
      p_seat_limit: limit,
      p_day_id: dayId,
    });
    if (err) setError(err.message);
    else {
      setEditing((prev) => {
        const next = { ...prev };
        delete next[dayId];
        return next;
      });
      await refresh();
    }
  }

  async function removeDay(dayId: string) {
    if (!window.confirm("Delete this camp day? Only empty days can be deleted.")) {
      return;
    }
    setError(null);
    const supabase = createClient();
    const { error: err } = await supabase.rpc("delete_camp_day", {
      p_day_id: dayId,
    });
    if (err) setError(err.message);
    else await refresh();
  }

  return (
    <Card>
      <SectionTitle hint={campName}>Camp days & seats</SectionTitle>
      <p className="mb-3 text-sm text-muted">
        Each day has a seat cap. Registration closes for a day when full; other
        days stay open. One patient = one day (they can change later if seats
        remain).
      </p>

      <ul className="mb-4 divide-y divide-border">
        {days.map((d) => (
          <li key={d.id} className="space-y-2 py-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold">{formatCampDay(d.day_date)}</p>
                <p className="text-xs text-muted">
                  {d.seats_taken} taken · {d.seats_left} left
                </p>
              </div>
              <Badge tone={d.is_full ? "wait" : "ok"}>
                {d.is_full ? "Full" : "Open"}
              </Badge>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[7rem] flex-1">
                <Input
                  label="Seat limit"
                  type="number"
                  min={d.seats_taken}
                  value={editing[d.id] ?? String(d.seat_limit)}
                  onChange={(e) =>
                    setEditing((prev) => ({ ...prev, [d.id]: e.target.value }))
                  }
                />
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="w-auto"
                onClick={() => saveSeats(d.id, d.day_date)}
              >
                Save
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-auto text-danger"
                onClick={() => removeDay(d.id)}
              >
                Delete
              </Button>
            </div>
          </li>
        ))}
        {!days.length ? (
          <li className="py-2">
            <EmptyState>No days yet — add the first below.</EmptyState>
          </li>
        ) : null}
      </ul>

      <form onSubmit={addDay} className="space-y-3 border-t border-border pt-4">
        <p className="text-sm font-medium">Add day</p>
        <Input
          label="Date"
          type="date"
          required
          value={dayDate}
          onChange={(e) => setDayDate(e.target.value)}
        />
        <Input
          label="Seat limit"
          type="number"
          min={0}
          required
          value={seats}
          onChange={(e) => setSeats(e.target.value)}
        />
        <ErrorBox message={error} />
        <Button type="submit" variant="secondary" disabled={loading}>
          {loading ? "Saving…" : "Add / update day"}
        </Button>
      </form>
    </Card>
  );
}
