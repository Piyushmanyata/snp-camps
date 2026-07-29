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
import {
  markSeenWithRetries,
  undoMarkSeenWithRetries,
} from "@/lib/desk-ops";

export type LiveQueuePatient = {
  id: string;
  reg_no: number;
  full_name: string;
  phone: string | null;
};

/** Waiting queue. Mark seen removes the patient from the list (D22). */
export function LiveQueue({
  initial,
  initialTotal,
  campId,
  /** False when SSR queue failed — do not treat empty as success (#63). */
  initialLoadKnown = true,
}: {
  initial: LiveQueuePatient[];
  initialTotal?: number;
  campId: string | null;
  initialLoadKnown?: boolean;
}) {
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Last patient marked seen from this list — the undo target (D25).
  const [undoable, setUndoable] = useState<LiveQueuePatient | null>(null);

  const {
    waiting: rows,
    waitingTotal: total,
    freshness,
    waitingKnown,
    refreshing,
    refresh,
    markRemoved,
    clearRemoved,
  } = useCampDeskLive(campId, {
    waiting: initial,
    waitingTotal: initialTotal ?? initial.length,
    // SSR always seeds known when this component mounts with a successful
    // or empty initial list; pass waitingKnown=false from pages on SSR fail.
    waitingKnown: initialLoadKnown,
  });

  function manualRefresh() {
    setToastMsg(null);
    setError(null);
    refresh();
  }

  function deskRpc(supabase: ReturnType<typeof createClient>) {
    return async (fn: string, args: Record<string, unknown>) => {
      const result = await supabase.rpc(fn, args);
      return {
        data: result.data,
        error: result.error
          ? {
              message: result.error.message,
              code: result.error.code,
              details: result.error.details,
              hint: result.error.hint,
            }
          : null,
      };
    };
  }

  async function markSeen(patient: LiveQueuePatient) {
    if (busyId) return;
    setError(null);
    setBusyId(patient.id);

    const outcome = await markSeenWithRetries({
      patientId: patient.id,
      rpc: deskRpc(createClient()),
      errorContext: "live-queue.mark-seen",
      errorFallback: "Could not mark this patient seen. Try again.",
    });

    if (!outcome.ok) {
      setError(outcome.error);
      clearRemoved(patient.id);
      setBusyId(null);
      return;
    }

    const row = outcome.row;
    markRemoved(patient.id);

    if (row.already_seen) {
      setError(
        row.seen_by_name
          ? `Already seen by ${row.seen_by_name}`
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

    setToastMsg(`#${patient.reg_no} ${patient.full_name} marked seen`);
    setUndoable(patient);
    refresh();
    setBusyId(null);
  }

  async function undoSeen(patient: LiveQueuePatient) {
    if (busyId) return;
    setError(null);
    setBusyId(patient.id);

    const outcome = await undoMarkSeenWithRetries({
      patientId: patient.id,
      rpc: deskRpc(createClient()),
      errorContext: "live-queue.undo-mark-seen",
    });

    if (!outcome.ok) {
      setError(outcome.error);
      setBusyId(null);
      return;
    }

    setUndoable(null);
    setToastMsg(`#${patient.reg_no} back in the queue`);
    clearRemoved(patient.id);
    refresh();
    setBusyId(null);
  }

  const statusHint =
    freshness === "stale-error"
      ? " · stale"
      : freshness === "error"
        ? " · unavailable"
        : freshness === "refreshing"
          ? " · refreshing"
          : freshness === "fresh"
            ? " · live"
            : "";

  const queueFailed =
    !waitingKnown &&
    (freshness === "error" ||
      freshness === "stale-error" ||
      (freshness === "refreshing" && rows.length === 0 && !initialLoadKnown));
  const showEmpty = waitingKnown && rows.length === 0;
  const showRows = waitingKnown || rows.length > 0;

  return (
    <div>
      <ErrorBox message={error} />
      <DeskFreshnessIndicator
        freshness={freshness}
        onRetry={manualRefresh}
        hasKnownData={waitingKnown}
      />
      {toastMsg ? (
        <Toast message={toastMsg} onClose={() => setToastMsg(null)} />
      ) : null}
      {undoable ? (
        <div
          className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-background px-3 py-2"
          role="status"
        >
          <p className="text-sm">
            <span className="tabular font-semibold text-brand">
              #{undoable.reg_no}
            </span>{" "}
            {undoable.full_name} marked seen.
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="w-auto"
              disabled={busyId !== null}
              onClick={() => void undoSeen(undoable)}
            >
              Undo
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="w-auto"
              onClick={() => setUndoable(null)}
            >
              Dismiss
            </Button>
          </div>
        </div>
      ) : null}
      <div className="mb-1 flex items-center justify-between gap-2 px-1 text-[11px] text-muted">
        <span aria-live="polite">
          {!waitingKnown && freshness === "refreshing"
            ? "Loading queue…"
            : queueFailed
              ? "Queue unavailable"
              : total > rows.length
                ? "Showing first " + rows.length + " of " + total
                : total + " waiting"}
          {waitingKnown || freshness === "fresh" ? statusHint : ""}
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
        {showRows
          ? rows.map((p, index) => (
          <li key={p.id} className="px-1 py-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-start gap-2.5">
                <span
                  className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-warning-soft text-[11px] font-bold tabular-nums text-warning ring-1 ring-amber-300/60"
                  aria-label={`Position ${index + 1}`}
                >
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="tabular text-sm font-bold text-brand">
                    #{p.reg_no}
                  </p>
                  <p className="break-words font-semibold leading-snug">
                    {p.full_name}
                  </p>
                  {p.phone ? (
                    <p className="break-all text-xs text-muted">{p.phone}</p>
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
                <button
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => void markSeen(p)}
                  data-testid="mark-seen"
                  className="pressable inline-flex min-h-12 items-center rounded-lg border border-brand/25 bg-brand-soft px-3 py-2 text-sm font-semibold text-brand transition-colors hover:bg-white disabled:opacity-50"
                >
                  {busyId === p.id ? "…" : "Mark seen"}
                </button>
              </div>
            </div>
          </li>
        ))
          : null}
        {queueFailed && !rows.length ? (
          <li className="px-1 py-2">
            {/* Distinct from empty: hard load failure, not "nothing here". */}
            <p className="rounded-xl bg-red-50 px-3 py-3 text-sm font-medium text-red-900 ring-1 ring-red-200" role="alert">
              Queue could not be loaded. Use Refresh or Try again — this is not an empty line.
            </p>
          </li>
        ) : null}
        {showEmpty ? (
          <li className="px-1 py-2">
            <EmptyState>
              Queue is empty. Printing a patient&apos;s prescription puts them
              here, in arrival order.
            </EmptyState>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
