"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatCampDay, type CampDayStats } from "@/lib/types";
import { Button, ErrorBox, Select, SuccessBox } from "@/components/ui";

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

  useEffect(() => {
    if (currentDayId) {
      setActiveDayId(currentDayId);
      setDayId(currentDayId);
    }
  }, [currentDayId]);

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
    try {
      const supabase = createClient();
      const { data, error: err } = await supabase.rpc("change_camp_day", {
        p_patient_id: patientId,
        p_new_day_id: dayId,
      });
      if (err) {
        setError(err.message);
        return;
      }
      const row = Array.isArray(data) ? data[0] : data;
      const updatedDayId = row?.camp_day_id || dayId;
      setActiveDayId(updatedDayId);
      setDayId(updatedDayId);
      if (onDayChanged) {
        onDayChanged(updatedDayId, row?.day_date);
      }
      setOk(
        row?.day_date
          ? `Moved to ${formatCampDay(row.day_date)}`
          : "Day updated",
      );
      router.refresh();
    } catch {
      setError("Could not change the day. Check the connection and try again.");
    } finally {
      setLoading(false);
    }
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
