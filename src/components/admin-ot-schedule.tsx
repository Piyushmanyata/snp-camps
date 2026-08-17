"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatCampDay } from "@/lib/types";
import { Button, EmptyState, ErrorBox, Input } from "@/components/ui";
import { mapDbError } from "@/lib/public-error";

export type OtScheduleRow = {
  id: string;
  day_date: string;
  venue: string;
  seat_limit: number;
  seats_taken: number;
};

export function AdminOtSchedule({
  campId,
  initialDays,
}: {
  campId: string;
  initialDays: OtScheduleRow[];
}) {
  const router = useRouter();
  const days = initialDays;
  const isValidNum = (s: string) => {
    const t = s.trim();
    return /^\d+$/.test(t) && Number(t) <= 2_147_483_647;
  };

  const [dayDate, setDayDate] = useState("");
  const [venue, setVenue] = useState("");
  const [seats, setSeats] = useState("20");
  const [addError, setAddError] = useState<string | null>(null);
  const [dayError, setDayError] = useState<{
    dayId: string;
    message: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<
    Record<string, { seats: string; venue: string }>
  >({});
  const mutationBusy = loading || savingId !== null;

  async function refresh() {
    router.refresh();
  }

  function draft(day: OtScheduleRow) {
    return editing[day.id] ?? {
      seats: String(day.seat_limit),
      venue: day.venue,
    };
  }

  async function addDay(e: React.FormEvent) {
    e.preventDefault();
    if (mutationBusy) return;
    setLoading(true);
    setAddError(null);
    if (!dayDate || !venue.trim() || !isValidNum(seats)) {
      setAddError("Enter a date, venue, and a seat limit of zero or more.");
      setLoading(false);
      return;
    }
    try {
      const supabase = createClient();
      const { error: err } = await supabase.rpc("upsert_ot_schedule_day", {
        p_camp_id: campId,
        p_day_date: dayDate,
        p_venue: venue.trim(),
        p_seat_limit: Number(seats),
        p_day_id: null,
      });
      if (err) {
        setAddError(
          mapDbError(err, {
            context: "admin-ot-schedule.add",
            fallback: "Could not save this OT day. Try again.",
          }),
        );
      } else {
        setDayDate("");
        setVenue("");
        setSeats("20");
        await refresh();
      }
    } catch {
      setAddError("Could not save this OT day. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  async function saveDay(day: OtScheduleRow) {
    if (mutationBusy) return;
    setDayError(null);
    const next = draft(day);
    if (!next.venue.trim() || !isValidNum(next.seats)) {
      setDayError({
        dayId: day.id,
        message: "Venue and a whole-number seat limit are required.",
      });
      return;
    }
    const limit = Number(next.seats);
    if (limit < day.seats_taken) {
      setDayError({
        dayId: day.id,
        message: `Seat limit cannot be below ${day.seats_taken} existing bookings`,
      });
      return;
    }
    setSavingId(day.id);
    try {
      const supabase = createClient();
      const { error: err } = await supabase.rpc("upsert_ot_schedule_day", {
        p_camp_id: campId,
        p_day_date: day.day_date,
        p_venue: next.venue.trim(),
        p_seat_limit: limit,
        p_day_id: day.id,
      });
      if (err) {
        setDayError({
          dayId: day.id,
          message: mapDbError(err, {
            context: "admin-ot-schedule.save",
            fallback: "Could not update the OT day. Try again.",
          }),
        });
      } else {
        setEditing((prev) => {
          const copy = { ...prev };
          delete copy[day.id];
          return copy;
        });
        await refresh();
      }
    } catch {
      setDayError({
        dayId: day.id,
        message:
          "Could not update the OT day. Check your connection and try again.",
      });
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        OT dates are independent of camp days. Seats taken is the count of
        still-deferred OT items.
      </p>
      <ul className="mb-4 divide-y divide-border">
        {days.map((d) => {
          const next = draft(d);
          return (
            <li key={d.id} className="space-y-2 py-3">
              <p className="font-semibold">{formatCampDay(d.day_date)}</p>
              <p className="text-xs text-muted">
                Seats: {d.seats_taken} taken · {Math.max(0, d.seat_limit - d.seats_taken)} left
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-[8rem] flex-1">
                  <Input
                    label="Venue"
                    disabled={mutationBusy}
                    value={next.venue}
                    onChange={(e) =>
                      setEditing((prev) => ({
                        ...prev,
                        [d.id]: { ...next, venue: e.target.value },
                      }))
                    }
                  />
                </div>
                <div className="min-w-[7rem]">
                  <Input
                    label="Seat limit"
                    type="number"
                    min={d.seats_taken}
                    disabled={mutationBusy}
                    value={next.seats}
                    onChange={(e) =>
                      setEditing((prev) => ({
                        ...prev,
                        [d.id]: { ...next, seats: e.target.value },
                      }))
                    }
                  />
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="w-auto"
                  disabled={mutationBusy}
                  loading={savingId === d.id}
                  onClick={() => void saveDay(d)}
                >
                  {savingId === d.id ? "Saving…" : "Save"}
                </Button>
              </div>
              <ErrorBox
                message={dayError?.dayId === d.id ? dayError.message : null}
              />
            </li>
          );
        })}
        {!days.length ? (
          <li className="py-2">
            <EmptyState>No OT dates yet — add the first below.</EmptyState>
          </li>
        ) : null}
      </ul>
      <form onSubmit={addDay} className="space-y-3 border-t border-border pt-4">
        <p className="text-sm font-medium">Add OT date</p>
        <Input
          label="Date"
          type="date"
          required
          disabled={mutationBusy}
          value={dayDate}
          onChange={(e) => setDayDate(e.target.value)}
        />
        <Input
          label="Venue"
          required
          disabled={mutationBusy}
          value={venue}
          onChange={(e) => setVenue(e.target.value)}
        />
        <Input
          label="Seat limit"
          type="number"
          min={0}
          required
          disabled={mutationBusy}
          value={seats}
          onChange={(e) => setSeats(e.target.value)}
        />
        <ErrorBox message={addError} />
        <Button type="submit" variant="secondary" disabled={mutationBusy}>
          {loading ? "Saving…" : "Add / update OT date"}
        </Button>
      </form>
    </div>
  );
}
