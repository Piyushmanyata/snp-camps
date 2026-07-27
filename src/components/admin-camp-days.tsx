"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatCampDay, type CampDayStats } from "@/lib/types";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBox,
  Input,
} from "@/components/ui";
import { mapDbError } from "@/lib/public-error";

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
  const days = initialDays;

  const isValidNum = (s: string, allowBlank = false) => {
    const t = s.trim();
    if (allowBlank && t === "") return true;
    return /^\d+$/.test(t) && Number(t) <= 2_147_483_647;
  };

  const [dayDate, setDayDate] = useState("");
  const [seats, setSeats] = useState("100");
  const [theatreSeats, setTheatreSeats] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [dayError, setDayError] = useState<{
    dayId: string;
    message: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [editingTheatre, setEditingTheatre] = useState<Record<string, string>>({});
  const mutationBusy = loading || savingId !== null || deletingId !== null;

  async function refresh() {
    router.refresh();
  }

  async function addDay(e: React.FormEvent) {
    e.preventDefault();
    if (mutationBusy) return;
    setLoading(true);
    setAddError(null);
    if (!dayDate || !isValidNum(seats) || !isValidNum(theatreSeats, true)) {
      setAddError("Enter a date, seat limit ≥ 0, and valid theatre capacity (or blank)");
      setLoading(false);
      return;
    }
    const limit = Number(seats);
    const theatreCap = theatreSeats.trim() === "" ? null : Number(theatreSeats);
    try {
      const supabase = createClient();
      const { error: err } = await supabase.rpc("upsert_camp_day", {
        p_camp_id: campId,
        p_day_date: dayDate,
        p_seat_limit: limit,
        p_day_id: null,
        p_theatre_capacity: theatreCap,
      });
      if (err) {
        setAddError(
          mapDbError(err, {
            context: "admin-camp-days.add",
            fallback: "Could not save this camp day. Try again.",
          }),
        );
      } else {
        setDayDate("");
        setSeats("100");
        setTheatreSeats("");
        await refresh();
      }
    } catch {
      setAddError("Could not save this camp day. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  async function saveSeats(
    dayId: string,
    dayDateIso: string,
    seatsTaken: number,
    otReserved: number = 0,
  ) {
    if (mutationBusy) return;
    setDayError(null);
    const seatsVal = editing[dayId] ?? "";
    const theatreVal = editingTheatre[dayId] ?? "";

    if (!isValidNum(seatsVal)) {
      setDayError({
        dayId,
        message: "Seat limit must be a whole number ≥ 0",
      });
      return;
    }
    if (!isValidNum(theatreVal, true)) {
      setDayError({
        dayId,
        message: "Theatre capacity must be a whole number ≥ 0 or blank for unlimited",
      });
      return;
    }

    const limit = Number(seatsVal);
    if (limit < seatsTaken) {
      setDayError({
        dayId,
        message: `Seat limit cannot be below ${seatsTaken} existing bookings`,
      });
      return;
    }

    const theatreCap = theatreVal.trim() === "" ? null : Number(theatreVal);
    if (theatreCap !== null && theatreCap < otReserved) {
      setDayError({
        dayId,
        message: `Theatre capacity cannot be below ${otReserved} reserved OT slots`,
      });
      return;
    }

    setSavingId(dayId);
    try {
      const supabase = createClient();
      const { error: err } = await supabase.rpc("upsert_camp_day", {
        p_camp_id: campId,
        p_day_date: dayDateIso,
        p_seat_limit: limit,
        p_day_id: dayId,
        p_theatre_capacity: theatreCap,
      });
      if (err) {
        setDayError({
          dayId,
          message: mapDbError(err, {
            context: "admin-camp-days.save-seats",
            fallback: "Could not update the camp day limit. Try again.",
          }),
        });
      } else {
        setEditing((prev) => {
          const next = { ...prev };
          delete next[dayId];
          return next;
        });
        setEditingTheatre((prev) => {
          const next = { ...prev };
          delete next[dayId];
          return next;
        });
        await refresh();
      }
    } catch {
      setDayError({
        dayId,
        message: "Could not update the camp day limit. Check your connection and try again.",
      });
    } finally {
      setSavingId(null);
    }
  }

  async function removeDay(dayId: string) {
    if (mutationBusy) return;
    if (!window.confirm("Delete this camp day? Only empty days can be deleted.")) {
      return;
    }
    setDeletingId(dayId);
    setDayError(null);
    try {
      const supabase = createClient();
      const { error: err } = await supabase.rpc("delete_camp_day", {
        p_day_id: dayId,
      });
      if (err) {
        setDayError({
          dayId,
          message: mapDbError(err, {
            context: "admin-camp-days.delete",
            fallback: "Could not delete this camp day. Try again.",
          }),
        });
      } else await refresh();
    } catch (e) {
      setDayError({
        dayId,
        message: mapDbError(e, {
          context: "admin-camp-days.delete.network",
          fallback:
            "Could not delete this camp day. Check your connection and try again.",
        }),
      });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        {campName}: each day has a seat cap and an optional theatre slot cap.
      </p>

      <ul className="mb-4 divide-y divide-border">
        {days.map((d) => {
          const otReserved = d.theatre_reserved ?? 0;
          const currentTheatreVal =
            editingTheatre[d.id] ??
            (d.theatre_capacity === null || d.theatre_capacity === undefined
              ? ""
              : String(d.theatre_capacity));
          return (
            <li key={d.id} className="space-y-2 py-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold">{formatCampDay(d.day_date)}</p>
                  <p className="text-xs text-muted">
                    Seats: {d.seats_taken} taken · {d.seats_left} left | OT Slots:{" "}
                    {d.theatre_capacity === null || d.theatre_capacity === undefined
                      ? `${otReserved} reserved (Unlimited)`
                      : `${otReserved} reserved · ${d.theatre_remaining ?? 0} left (of ${d.theatre_capacity})`}
                  </p>
                </div>
                <Badge tone={d.is_full ? "wait" : "ok"}>
                  {d.is_full ? "Seats Full" : "Open"}
                </Badge>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-[7rem] flex-1">
                  <Input
                    label="Seat limit"
                    type="number"
                    min={d.seats_taken}
                    disabled={mutationBusy}
                    value={editing[d.id] ?? String(d.seat_limit)}
                    onChange={(e) =>
                      setEditing((prev) => ({ ...prev, [d.id]: e.target.value }))
                    }
                  />
                </div>
                <div className="min-w-[7rem] flex-1">
                  <Input
                    label="Theatre capacity (blank = unlimited)"
                    type="number"
                    min={otReserved}
                    placeholder="Unlimited"
                    disabled={mutationBusy}
                    value={currentTheatreVal}
                    onChange={(e) =>
                      setEditingTheatre((prev) => ({
                        ...prev,
                        [d.id]: e.target.value,
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
                  onClick={() => saveSeats(d.id, d.day_date, d.seats_taken, otReserved)}
                >
                  {savingId === d.id ? "Saving…" : "Save"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-auto text-danger"
                  disabled={mutationBusy}
                  loading={deletingId === d.id}
                  onClick={() => removeDay(d.id)}
                >
                  {deletingId === d.id ? "Deleting…" : "Delete"}
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
          disabled={mutationBusy}
          value={dayDate}
          onChange={(e) => setDayDate(e.target.value)}
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
        <Input
          label="Theatre capacity (optional, blank = unlimited)"
          type="number"
          min={0}
          placeholder="Unlimited"
          disabled={mutationBusy}
          value={theatreSeats}
          onChange={(e) => setTheatreSeats(e.target.value)}
        />
        <ErrorBox message={addError} />
        <Button type="submit" variant="secondary" disabled={mutationBusy}>
          {loading ? "Saving…" : "Add / update day"}
        </Button>
      </form>
    </div>
  );
}
