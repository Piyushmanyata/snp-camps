"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { changeCampDayWithRetries } from "@/lib/desk-ops";
import { formatCampDay, type CampDayStats } from "@/lib/types";
import { Button, ErrorBox, Select, SuccessBox } from "@/components/ui";
import { mapDbError } from "@/lib/public-error";

export function ChangeDay({
  patientId,
  currentDayId,
  days,
  queueStatus = "registered",
  campActive = true,
  onDayChanged,
}: {
  patientId: string;
  currentDayId: string | null;
  days: CampDayStats[];
  /** When waiting/seen, day change is locked (also enforced in DB). */
  queueStatus?: string | null;
  campActive?: boolean;
  onDayChanged?: (newDayId: string, newDayDate?: string) => void;
}) {
  const router = useRouter();
  const [activeDayId, setActiveDayId] = useState(currentDayId || "");
  const [dayId, setDayId] = useState(currentDayId || "");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [prevDayId, setPrevDayId] = useState(currentDayId);
  if (currentDayId !== prevDayId) {
    setPrevDayId(currentDayId);
    setActiveDayId(currentDayId || "");
    setDayId(currentDayId || "");
  }

  const locked =
    !campActive || queueStatus === "waiting" || queueStatus === "seen";

  if (locked) {
    const dayLabel = days.find((d) => d.id === activeDayId);
    return (
      <div className="rounded-xl border border-border bg-background px-3 py-3 text-sm text-muted">
        <p className="font-medium text-foreground">
          {dayLabel
            ? formatCampDay(dayLabel.day_date)
            : "Camp day locked"}
        </p>
        <p className="mt-1 text-xs">
          {!campActive
            ? "Day cannot be changed because this camp is no longer active."
            : queueStatus === "seen"
            ? "Day cannot be changed after the patient has been seen."
            : "Day cannot be changed after joining the queue."}
        </p>
      </div>
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!dayId) {
      setError("Select a day");
      return;
    }
    if (dayId === activeDayId) {
      setOk("Already on this day");
      return;
    }
    setLoading(true);
    setError(null);
    setOk(null);
    // Selection (dayId) is kept on failure so Try Again reuses it (#32).
    const supabase = createClient();
    const outcome = await changeCampDayWithRetries({
      patientId,
      newDayId: dayId,
      rpc: async (fn, args) => {
        const result = await supabase.rpc(fn, args);
        return {
          data: result.data,
          error: result.error ? { message: result.error.message } : null,
        };
      },
      mapRpcError: (message) =>
        mapDbError(
          { message },
          {
            context: "change-day.rpc",
            fallback: "Could not change the day. Try again.",
          },
        ),
    });
    if (!outcome.ok) {
      setError(outcome.error);
      setLoading(false);
      return;
    }
    const updatedDayId = outcome.row.camp_day_id || dayId;
    setActiveDayId(updatedDayId);
    setDayId(updatedDayId);
    if (onDayChanged) {
      onDayChanged(updatedDayId, outcome.row.day_date);
    }
    setOk(
      outcome.row.day_date
        ? `Moved to ${formatCampDay(outcome.row.day_date)}`
        : "Day updated",
    );
    router.refresh();
    setLoading(false);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <Select
        label="Camp day"
        value={dayId}
        onChange={(e) => setDayId(e.target.value)}
        required
      >
        <option value="">Select day…</option>
        {days.map((d) => {
          const isCurrent = d.id === activeDayId;
          const disabled = d.is_full && !isCurrent;
          return (
            <option key={d.id} value={d.id} disabled={disabled}>
              {formatCampDay(d.day_date)}
              {isCurrent
                ? " · current"
                : disabled
                  ? " · full"
                  : ` · ${d.seats_left} left`}
            </option>
          );
        })}
      </Select>
      <ErrorBox message={error} />
      <SuccessBox message={ok} />
      <Button
        type="submit"
        variant="secondary"
        disabled={loading}
        loading={loading}
      >
        {loading ? "Updating…" : "Change day"}
      </Button>
    </form>
  );
}
