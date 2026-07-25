"use client";

import { useCallback, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { POLL_MS, useFixedPoll } from "@/lib/poll";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBox,
  Spinner,
} from "@/components/ui";
import { Toast } from "@/components/toast";
import type { DoctorOption } from "@/lib/types";
import { isSuccessfulAssignment } from "@/lib/queue-assignment";
import { mapDbError } from "@/lib/public-error";

export type LiveQueuePatient = {
  id: string;
  reg_no: number;
  full_name: string;
  phone: string | null;
};

/** Waiting queue. Assign doctor marks seen and removes from list. */
export function LiveQueue({
  initial,
  initialTotal,
  campId,
  doctors = [],
  mode = "volunteer",
  pollMs = POLL_MS,
}: {
  initial: LiveQueuePatient[];
  initialTotal?: number;
  campId: string | null;
  doctors?: DoctorOption[];
  mode?: "volunteer" | "doctor" | "admin";
  /** Auto-refresh interval; 0 = manual only. Default 2 min. */
  pollMs?: number;
}) {
  const router = useRouter();
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [refreshSource, setRefreshSource] = useState<LiveQueuePatient[] | null>(
    null,
  );
  const [queueState, setQueueState] = useState<{
    source: LiveQueuePatient[];
    rows: LiveQueuePatient[];
    total: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pickId, setPickId] = useState<string | null>(null);
  const [doctorId, setDoctorId] = useState("");
  const currentQueue =
    queueState?.source === initial
      ? queueState
      : { source: initial, rows: initial, total: initialTotal ?? initial.length };
  const rows = currentQueue.rows;
  const total = currentQueue.total;
  const refreshMessage = refreshSource
    ? refreshSource === initial
      ? "Refreshing queue…"
      : "Queue updated"
    : null;

  function updateQueue(
    update: (current: typeof currentQueue) => typeof currentQueue,
  ) {
    setQueueState((previous) =>
      update(
        previous?.source === initial
          ? previous
          : {
              source: initial,
              rows: initial,
              total: initialTotal ?? initial.length,
            },
      ),
    );
  }

  const [isPending, startTransition] = useTransition();
  const refreshQueue = useCallback(() => {
    startTransition(() => {
      router.refresh();
    });
  }, [router]);

  function manualRefresh() {
    setToastMsg(null);
    setRefreshSource(initial);
    refreshQueue();
  }

  useFixedPoll(refreshQueue, pollMs, Boolean(campId));

  async function assign(patientId: string, chosen: string | null) {
    if (busyId) return;
    setError(null);
    setBusyId(patientId);
    try {
      const supabase = createClient();
      const { data, error: err } = await supabase.rpc("assign_patient_doctor", {
        p_patient_id: patientId,
        p_reg_no: null,
        p_doctor_id: chosen,
      });

      if (err) {
        setError(
          mapDbError(err, {
            context: "live-queue.assign",
            fallback: "Could not assign this patient. Try again.",
          }),
        );
        return;
      }

      const row = (Array.isArray(data) ? data[0] : data) as {
        already_seen: boolean;
        doctor_id: string | null;
        doctor_name?: string | null;
        error_code: string | null;
        queue_status: string;
      } | null;

      if (row?.error_code === "doctor_required") {
        setError("Select a doctor.");
        return;
      }
      if (row?.error_code === "already_seen" || row?.already_seen) {
        setError(
          row.doctor_name
            ? `Already seen by ${row.doctor_name}`
            : "Already seen",
        );
        updateQueue((current) => ({
          ...current,
          rows: current.rows.filter((r) => r.id !== patientId),
          total: Math.max(0, current.total - 1),
        }));
        startTransition(() => {
          router.refresh();
        });
        return;
      }

      if (!row || !isSuccessfulAssignment(row)) {
        setError(
          row?.error_code
            ? "Could not assign this patient. Refresh and try again."
            : "Doctor assignment did not complete. No success was recorded.",
        );
        return;
      }

      try {
        if (typeof window !== "undefined" && "vibrate" in navigator) {
          navigator.vibrate([100, 30, 100]);
        }
      } catch {
        /* ignore */
      }

      setRefreshSource(null);
      setToastMsg("Patient assignment complete");
      updateQueue((current) => ({
        ...current,
        rows: current.rows.filter((r) => r.id !== patientId),
        total: Math.max(0, current.total - 1),
      }));
      setPickId(null);
      setDoctorId("");
      startTransition(() => {
        router.refresh();
      });
    } catch {
      setError(
        "Could not assign this patient. Check the connection and try again.",
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <ErrorBox message={error} />
      {toastMsg ? (
        <Toast message={toastMsg} onClose={() => setToastMsg(null)} />
      ) : null}
      {refreshMessage ? (
        <Toast
          message={refreshMessage}
          onClose={() => setRefreshSource(null)}
        />
      ) : null}
      <div className="mb-1 flex items-center justify-between gap-2 px-1 text-[11px] text-muted">
        <span aria-live="polite">
          {total > rows.length
            ? "Showing first " + rows.length + " of " + total
            : total + " waiting"}
          {pollMs > 0
            ? ` · auto every ${Math.round(pollMs / 60_000)} min`
            : ""}
        </span>
        <button
          type="button"
          onClick={manualRefresh}
          disabled={isPending || !campId}
          className="pressable inline-flex min-h-8 items-center gap-1 rounded-lg px-2 font-semibold text-brand hover:bg-brand-soft disabled:opacity-50"
        >
          {isPending ? <Spinner className="h-3 w-3" /> : null}
          {isPending ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <ul
        className="divide-y divide-border lg:max-h-[70vh] lg:overflow-y-auto"
        aria-label="Patients waiting in queue"
      >
        {rows.map((p, index) => (
          <li key={p.id} className="px-1 py-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-start gap-2.5">
                <span
                  className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-warning-soft text-[11px] font-bold tabular-nums text-warning ring-1 ring-amber-300/60"
                  aria-label={`Position ${index + 1}`}
                >
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <p className="truncate font-semibold">
                    <span className="tabular text-brand">#{p.reg_no}</span>{" "}
                    {p.full_name}
                  </p>
                  {p.phone ? (
                    <p className="truncate text-xs text-muted">{p.phone}</p>
                  ) : null}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Badge tone="wait">In queue</Badge>
                <Link
                  href={`/print/${p.id}`}
                  className="pressable rounded-lg border border-border bg-white px-2.5 py-2 text-sm font-semibold text-brand shadow-sm transition-colors hover:bg-brand-soft"
                >
                  Reprint
                </Link>
                {mode === "doctor" ? (
                  <button
                    type="button"
                    disabled={busyId !== null}
                    onClick={() => void assign(p.id, null)}
                    className="pressable rounded-lg border border-brand/25 bg-brand-soft px-2.5 py-2 text-sm font-semibold text-brand transition-colors hover:bg-white disabled:opacity-50"
                  >
                    {busyId === p.id ? "…" : "See now"}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busyId !== null}
                    aria-expanded={pickId === p.id}
                    onClick={() => {
                      setPickId(pickId === p.id ? null : p.id);
                      setDoctorId("");
                      setError(null);
                    }}
                    className="pressable rounded-lg border border-brand/25 bg-brand-soft px-2.5 py-2 text-sm font-semibold text-brand transition-colors hover:bg-white"
                  >
                    Assign
                  </button>
                )}
              </div>
            </div>

            {pickId === p.id && mode !== "doctor" ? (
              <div className="mt-2 space-y-2 rounded-xl border border-border bg-background p-3">
                <p className="text-xs font-semibold text-muted">
                  Which doctor is seeing them?
                </p>
                {doctors.length === 0 ? (
                  <p className="text-xs text-amber-800">
                    No doctors added yet.
                  </p>
                ) : (
                  <div
                    className="flex flex-wrap gap-1.5"
                    role="group"
                    aria-label="Select doctor"
                  >
                    {doctors.map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        aria-pressed={doctorId === d.id}
                        onClick={() => setDoctorId(d.id)}
                        className={`pressable min-h-10 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${
                          doctorId === d.id
                            ? "border-brand bg-brand-soft text-brand ring-1 ring-brand/20"
                            : "border-border bg-white hover:bg-brand-soft/50"
                        }`}
                      >
                        {d.full_name || "Doctor"}
                      </button>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    className="w-auto"
                    disabled={!doctorId || busyId === p.id}
                    loading={busyId === p.id}
                    onClick={() => void assign(p.id, doctorId)}
                  >
                    {busyId === p.id ? "…" : "Confirm seen"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="w-auto"
                    onClick={() => setPickId(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
        {!rows.length ? (
          <li className="px-1 py-2">
            <EmptyState>
              Queue is empty. Print puts patients here for FCFS. Doctors can
              also scan registered patients directly (no print).
            </EmptyState>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
