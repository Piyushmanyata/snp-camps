"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useCampDeskLive } from "@/lib/use-camp-desk-live";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBox,
  Spinner,
} from "@/components/ui";
import { DeskFreshnessIndicator } from "@/components/desk-freshness-indicator";
import { Toast } from "@/components/toast";
import type { DoctorOption } from "@/lib/types";
import { assignPatientDoctorWithRetries } from "@/lib/desk-ops";
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
}: {
  initial: LiveQueuePatient[];
  initialTotal?: number;
  campId: string | null;
  doctors?: DoctorOption[];
  mode?: "volunteer" | "doctor" | "admin";
}) {
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pickId, setPickId] = useState<string | null>(null);
  const [doctorId, setDoctorId] = useState("");

  const {
    waiting: rows,
    waitingTotal: total,
    freshness,
    refreshing,
    refresh,
    markRemoved,
    clearRemoved,
  } = useCampDeskLive(campId, {
    waiting: initial,
    waitingTotal: initialTotal ?? initial.length,
  });

  function manualRefresh() {
    setToastMsg(null);
    setError(null);
    refresh();
  }

  async function assign(patientId: string, chosen: string | null) {
    if (busyId) return;
    setError(null);
    setBusyId(patientId);
    // doctorId / pickId stay set on failure so Try Again reuses them (#32).
    const supabase = createClient();
    const outcome = await assignPatientDoctorWithRetries({
      patientId,
      doctorId: chosen,
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
            context: "live-queue.assign",
            fallback: "Could not assign this patient. Try again.",
          },
        ),
    });

    if (!outcome.ok) {
      setError(outcome.error);
      clearRemoved(patientId);
      setBusyId(null);
      return;
    }

    const row = outcome.row;
    markRemoved(patientId);
    if (row.already_seen || row.error_code === "already_seen") {
      setError(
        row.doctor_name
          ? `Already seen by ${row.doctor_name}`
          : "Already seen",
      );
      refresh();
      setBusyId(null);
      return;
    }

    try {
      if (typeof window !== "undefined" && "vibrate" in navigator) {
        navigator.vibrate([100, 30, 100]);
      }
    } catch {
      /* ignore */
    }

    setToastMsg("Patient assignment complete");
    setPickId(null);
    setDoctorId("");
    refresh();
    setBusyId(null);
  }

  const statusHint =
    freshness === "stale-error"
      ? " · stale"
      : freshness === "refreshing"
        ? " · refreshing"
        : freshness === "fresh"
          ? " · live"
          : "";

  return (
    <div>
      <ErrorBox message={error} />
      <DeskFreshnessIndicator freshness={freshness} onRetry={manualRefresh} />
      {toastMsg ? (
        <Toast message={toastMsg} onClose={() => setToastMsg(null)} />
      ) : null}
      <div className="mb-1 flex items-center justify-between gap-2 px-1 text-[11px] text-muted">
        <span aria-live="polite">
          {total > rows.length
            ? "Showing first " + rows.length + " of " + total
            : total + " waiting"}
          {statusHint}
        </span>
        <button
          type="button"
          onClick={manualRefresh}
          disabled={refreshing || !campId}
          className="pressable inline-flex min-h-12 items-center gap-1 rounded-lg px-3 font-semibold text-brand hover:bg-brand-soft disabled:opacity-50"
        >
          {refreshing ? <Spinner className="h-3 w-3" /> : null}
          {refreshing ? "Refreshing…" : "Refresh"}
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
                  className="pressable inline-flex min-h-12 items-center rounded-lg border border-border bg-white px-3 py-2 text-sm font-semibold text-brand transition-colors hover:bg-brand-soft"
                >
                  Reprint
                </Link>
                {mode === "doctor" ? (
                  <button
                    type="button"
                    disabled={busyId !== null}
                    onClick={() => void assign(p.id, null)}
                    className="pressable inline-flex min-h-12 items-center rounded-lg border border-brand/25 bg-brand-soft px-3 py-2 text-sm font-semibold text-brand transition-colors hover:bg-white disabled:opacity-50"
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
                    className="pressable inline-flex min-h-12 items-center rounded-lg border border-brand/25 bg-brand-soft px-3 py-2 text-sm font-semibold text-brand transition-colors hover:bg-white"
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
                        className={`pressable min-h-12 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
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
              Queue is empty. Check-in puts patients here in arrival order. Doctors can
              also scan registered patients directly (no print).
            </EmptyState>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
