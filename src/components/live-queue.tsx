"use client";

import { useCallback, useRef, useState, useTransition } from "react";
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
import type { DoctorOption } from "@/components/qr-scanner";

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
  const [queueState, setQueueState] = useState<{
    source: LiveQueuePatient[];
    rows: LiveQueuePatient[];
    total: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pickId, setPickId] = useState<string | null>(null);
  const [doctorId, setDoctorId] = useState("");
  const mutationGeneration = useRef(0);
  const currentQueue =
    queueState?.source === initial
      ? queueState
      : { source: initial, rows: initial, total: initialTotal ?? initial.length };
  const rows = currentQueue.rows;
  const total = currentQueue.total;

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
  const refreshQueue = useCallback((isManual = false) => {
    startTransition(() => {
      router.refresh();
    });
    if (isManual) {
      setToastMsg("Queue updated");
    }
  }, [router]);

  useFixedPoll(refreshQueue, pollMs, Boolean(campId));

  async function assign(patientId: string, chosen: string | null) {
    mutationGeneration.current += 1;
    setError(null);
    setBusyId(patientId);
    const supabase = createClient();
    const { data, error: err } = await supabase.rpc("assign_patient_doctor", {
      p_patient_id: patientId,
      p_reg_no: null,
      p_doctor_id: chosen,
    });
    setBusyId(null);

    if (err) {
      setError(err.message);
      return;
    }

    const row = (Array.isArray(data) ? data[0] : data) as {
      already_seen?: boolean;
      error_code?: string | null;
      doctor_name?: string | null;
    } | null;

    if (row?.error_code === "doctor_required") {
      setError("Select a doctor.");
      return;
    }
    try {
      if (typeof window !== "undefined" && "vibrate" in navigator) {
        navigator.vibrate([100, 30, 100]);
      }
    } catch {
      /* ignore */
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
      router.refresh();
      return;
    }

    setToastMsg("Patient assignment complete");
    updateQueue((current) => ({
      ...current,
      rows: current.rows.filter((r) => r.id !== patientId),
      total: Math.max(0, current.total - 1),
    }));
    setPickId(null);
    setDoctorId("");
    router.refresh();
  }

  return (
    <div>
      <ErrorBox message={error} />
      {toastMsg ? (
        <Toast message={toastMsg} onClose={() => setToastMsg(null)} />
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
          onClick={() => void refreshQueue(true)}
          disabled={isPending || !campId}
          className="pressable inline-flex min-h-8 items-center gap-1 rounded-lg px-2 font-semibold text-brand hover:bg-brand-soft disabled:opacity-50"
        >
          {isPending ? <Spinner className="h-3 w-3" /> : null}
          Refresh
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
                  className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-50 text-[11px] font-bold tabular-nums text-amber-900 ring-1 ring-amber-200/80"
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
                    disabled={busyId === p.id}
                    onClick={() => void assign(p.id, null)}
                    className="pressable rounded-lg border border-brand/25 bg-brand-soft px-2.5 py-2 text-sm font-semibold text-brand transition-colors hover:bg-white disabled:opacity-50"
                  >
                    {busyId === p.id ? "…" : "See now"}
                  </button>
                ) : (
                  <button
                    type="button"
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
                    No doctors yet — ask admin to add doctors.
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
