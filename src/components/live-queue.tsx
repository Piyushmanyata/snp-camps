"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Badge, EmptyState, ErrorBox } from "@/components/ui";

export type LiveQueuePatient = {
  id: string;
  reg_no: number;
  full_name: string;
  phone: string | null;
};

/** Waiting-only queue: print or mark seen removes the row from the live list. */
export function LiveQueue({
  initial,
  pollMs = 12_000,
}: {
  initial: LiveQueuePatient[];
  /** Soft poll so multi-desk desks stay in sync without Realtime overhead. */
  pollMs?: number;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [prev, setPrev] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (initial !== prev) {
    setPrev(initial);
    setRows(initial);
  }

  const refresh = useCallback(() => {
    startTransition(() => {
      router.refresh();
    });
  }, [router]);

  useEffect(() => {
    if (pollMs <= 0) return;
    const tick = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const id = window.setInterval(tick, pollMs);
    const onVis = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [pollMs, refresh]);

  async function markSeen(p: LiveQueuePatient) {
    setError(null);
    setBusyId(p.id);
    // Optimistic remove — seen patients leave the live queue immediately
    setRows((list) => list.filter((r) => r.id !== p.id));
    const supabase = createClient();
    const { error: err } = await supabase.rpc("mark_patient_seen", {
      p_id: p.id,
    });
    setBusyId(null);
    if (err) {
      setError(err.message);
      setRows((list) => {
        if (list.some((r) => r.id === p.id)) return list;
        return [...list, p].sort((a, b) => a.reg_no - b.reg_no);
      });
      return;
    }
    refresh();
  }

  return (
    <div>
      <ErrorBox message={error} />
      {pending ? (
        <p className="mb-1 px-1 text-[11px] text-muted">Updating queue…</p>
      ) : null}
      <ul className="divide-y divide-border lg:max-h-[70vh] lg:overflow-y-auto">
        {rows.map((p) => (
          <li
            key={p.id}
            className="flex items-center justify-between gap-2 px-1 py-3"
          >
            <div className="min-w-0">
              <p className="truncate font-semibold">
                <span className="tabular-nums text-brand">#{p.reg_no}</span>{" "}
                {p.full_name}
              </p>
              {p.phone ? (
                <p className="truncate text-xs text-muted">{p.phone}</p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Badge tone="wait">In queue</Badge>
              <Link
                href={`/print/${p.id}`}
                className="rounded-lg border border-border bg-white px-2.5 py-1.5 text-sm font-semibold text-brand shadow-sm transition hover:bg-brand-soft"
              >
                Print
              </Link>
              <button
                type="button"
                disabled={busyId === p.id}
                onClick={() => void markSeen(p)}
                className="rounded-lg border border-brand/25 bg-brand-soft px-2.5 py-1.5 text-sm font-semibold text-brand transition hover:bg-white disabled:opacity-50"
                title="Mark seen and remove from live queue"
              >
                {busyId === p.id ? "…" : "Seen"}
              </button>
            </div>
          </li>
        ))}
        {!rows.length ? (
          <li className="px-1 py-2">
            <EmptyState>
              Queue is empty. Scan a patient QR or enter reg no to check them
              in. Seen patients leave this list automatically.
            </EmptyState>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
