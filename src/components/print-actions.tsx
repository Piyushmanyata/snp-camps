"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui";
import { showErrorToast } from "@/lib/toast-bus";
import { resolvePrintRun, type PrintRunResult } from "@/lib/print-run";
import type { QueueStatus } from "@/lib/types";

export type PrintActionPatient = {
  id: string;
  regNo?: number;
  name?: string;
  queueStatus: QueueStatus;
};

const PRINT_STATUS_COPY: Record<
  QueueStatus,
  { printLabel: string; heading: string }
> = {
  seen: {
    printLabel: "Dobara print karein (1 page)",
    heading: "Print · dekha hua marij",
  },
  registered: {
    printLabel: "Parchi print karein",
    heading: "Parchi print ke liye taiyaar",
  },
};

export function PrintActions({
  className = "",
  patients,
  deskHref,
  autoPrint = false,
}: {
  className?: string;
  patients: PrintActionPatient[];
  deskHref: "/admin" | "/volunteer";
  autoPrint?: boolean;
}) {
  const primary = patients[0];
  const [isPrinting, setIsPrinting] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, QueueStatus>>(() => {
    const map: Record<string, QueueStatus> = {};
    for (const p of patients) map[p.id] = p.queueStatus;
    return map;
  });
  const [message, setMessage] = useState<{
    tone: "error" | "success" | "warning";
    text: string;
  } | null>(null);
  const autoStarted = useRef(false);

  const primaryStatus = primary
    ? statuses[primary.id] ?? primary.queueStatus
    : "registered";
  const statusCopy =
    PRINT_STATUS_COPY[primaryStatus] ?? PRINT_STATUS_COPY.registered;

  async function markPrinted(patientId: string): Promise<{
    ok: boolean;
    alreadyPrinted?: boolean;
    queueStatus?: QueueStatus;
    error?: string;
  }> {
    const response = await fetch(`/api/patients/${patientId}/print`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const payload = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      alreadyPrinted?: boolean;
      queueStatus?: QueueStatus;
      error?: string;
    };
    if (!response.ok || !payload.ok) {
      return {
        ok: false,
        error: payload.error || "Print taiyaar nahi ho paya. Dobara try karein.",
      };
    }
    return {
      ok: true,
      alreadyPrinted: payload.alreadyPrinted,
      queueStatus: payload.queueStatus,
    };
  }

  async function handlePrint() {
    if (patients.length === 0) {
      const text = "Is sheet par koi marij nahi.";
      setMessage({ tone: "error", text });
      showErrorToast(text);
      return;
    }
    setIsPrinting(true);
    setMessage(null);

    try {
      const nextStatuses = { ...statuses };
      const results: PrintRunResult[] = [];

      for (const p of patients) {
        const result = await markPrinted(p.id);
        results.push(result);
        if (result.ok && result.queueStatus) {
          nextStatuses[p.id] = result.queueStatus;
        }
      }
      setStatuses(nextStatuses);

      const outcome = resolvePrintRun(results);
      if (!outcome.print) {
        throw new Error(outcome.text);
      }

      setMessage({ tone: outcome.tone, text: outcome.text });
      if (outcome.tone === "error") {
        showErrorToast(outcome.text);
      }
      window.print();
    } catch (error) {
      const text =
        error instanceof Error &&
        error.message &&
        !/postgres|supabase|postgrest|stack|at\s+\w+/i.test(error.message)
          ? error.message
          : "Print taiyaar nahi ho paya. Dobara try karein.";
      setMessage({
        tone: "error",
        text,
      });
      showErrorToast(text);
    } finally {
      setIsPrinting(false);
    }
  }

  useEffect(() => {
    if (!autoPrint || autoStarted.current) return;
    autoStarted.current = true;
    void handlePrint();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional mount-only
  }, [autoPrint]);

  return (
    <div
      className={`flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between ${className}`}
      data-testid="print-actions"
      data-patient-count={patients.length}
    >
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-wide text-brand">
          {statusCopy.heading}
        </p>
        <p className="break-words text-base font-semibold">
          {`${primary?.regNo != null ? `#${primary.regNo}` : "Parchi"}${
            primary?.name ? ` · ${primary.name}` : ""
          }`}
        </p>
        {message ? (
          <p
            id="print-action-status"
            className={`mt-2 text-sm font-medium ${
              message.tone === "error"
                ? "text-red-700"
                : message.tone === "warning"
                  ? "text-amber-800"
                  : "text-emerald-700"
            }`}
            role={message.tone === "error" ? "alert" : "status"}
            data-testid="print-action-status"
          >
            {message.text}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          className="w-auto min-w-[9rem]"
          disabled={isPrinting || patients.length === 0}
          aria-busy={isPrinting}
          aria-describedby={message ? "print-action-status" : undefined}
          onClick={handlePrint}
          data-testid="print-sheet-button"
        >
          {isPrinting ? "Print taiyaar…" : statusCopy.printLabel}
        </Button>
        <Link
          href={deskHref}
          className="inline-flex min-h-12 items-center justify-center rounded-xl border border-border bg-brand-soft px-4 text-sm font-semibold text-brand transition hover:bg-white"
        >
          Desk par wapas
        </Link>
      </div>
    </div>
  );
}
