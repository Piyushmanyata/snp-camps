"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui";
import { clearA4BatchStorage } from "@/lib/a4-batch-queue";
import type { QueueStatus } from "@/lib/types";

export type PrintActionPatient = {
  id: string;
  regNo?: number;
  name?: string;
  queueStatus: QueueStatus;
};

/**
 * Print chrome for one or many patients on the slip sheet.
 * Batch mode marks each patient printed then opens the dialog once (#64).
 * Browser print completion is not knowable — operator must clear the batch
 * explicitly after physical confirmation.
 */
export function PrintActions({
  className = "",
  patients,
  deskHref,
  deskLabel,
  autoPrint = false,
  /** When true, show Start next sheet after print attempt (A4 batch). */
  isBatch = false,
}: {
  className?: string;
  patients: PrintActionPatient[];
  deskHref: "/admin" | "/volunteer";
  deskLabel: "Admin dashboard" | "Volunteer desk";
  /** When true (desk register flow), open the print dialog once on mount. */
  autoPrint?: boolean;
  isBatch?: boolean;
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
  const [printedOnce, setPrintedOnce] = useState(false);
  const autoStarted = useRef(false);

  const primaryStatus = primary ? statuses[primary.id] ?? primary.queueStatus : "registered";

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
        error: payload.error || "Could not prepare print.",
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
      setMessage({ tone: "error", text: "No patients on this sheet." });
      return;
    }
    setIsPrinting(true);
    setMessage(null);

    try {
      const nextStatuses = { ...statuses };
      let anyFail = false;
      let failText = "";

      for (const p of patients) {
        const result = await markPrinted(p.id);
        if (!result.ok) {
          anyFail = true;
          failText = result.error || "Could not prepare print.";
          // Continue marking others so partial sheets still check in where possible.
          continue;
        }
        const nextStatus =
          result.queueStatus === "seen" || result.queueStatus === "waiting"
            ? result.queueStatus
            : nextStatuses[p.id] === "seen"
              ? "seen"
              : "waiting";
        nextStatuses[p.id] = nextStatus;
      }
      setStatuses(nextStatuses);

      if (anyFail && patients.length === 1) {
        throw new Error(failText);
      }

      setPrintedOnce(true);
      if (anyFail) {
        setMessage({
          tone: "warning",
          text: `Some patients could not be checked in (${failText}). Print dialog is open — verify the sheet. Batch stays until you start a new sheet.`,
        });
      } else if (isBatch) {
        setMessage({
          tone: "success",
          text: printedOnce
            ? "Reprint: sheet still holds these patients until you start a new sheet."
            : `Sheet ready (${patients.length} slip${patients.length === 1 ? "" : "s"}). Confirm paper, then Start next sheet.`,
        });
      } else {
        const st = nextStatuses[primary!.id];
        setMessage({
          tone: "success",
          text:
            st === "seen"
              ? "Completed consultation confirmed. The print dialog is open."
              : "Patient is in line. The print dialog is open.",
        });
      }
      window.print();
    } catch (error) {
      const text =
        error instanceof Error &&
        error.message &&
        !/postgres|supabase|postgrest|stack|at\s+\w+/i.test(error.message)
          ? error.message
          : "Could not prepare the print. Please try again.";
      setMessage({
        tone: "error",
        text,
      });
    } finally {
      setIsPrinting(false);
    }
  }

  function startNextSheet() {
    clearA4BatchStorage();
    setPrintedOnce(false);
    setMessage({
      tone: "success",
      text: "Batch cleared. Next registrations fill a new A4 sheet.",
    });
  }

  useEffect(() => {
    if (!autoPrint || autoStarted.current) return;
    autoStarted.current = true;
    void handlePrint();
    // One-shot mount trigger for desk "Register karein aur print".
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional mount-only
  }, [autoPrint]);

  const labelBits = patients
    .map((p) => (p.regNo != null ? `#${p.regNo}` : p.id.slice(0, 8)))
    .join(" · ");

  return (
    <div
      className={`flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between ${className}`}
      data-testid="print-actions"
      data-batch={isBatch ? "true" : "false"}
      data-patient-count={patients.length}
    >
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-wide text-brand">
          {isBatch
            ? printedOnce
              ? "A4 batch · reprint available until new sheet"
              : `A4 batch · ${patients.length} of 4 slips`
            : primaryStatus === "seen"
              ? "Ready to print · consultation complete"
              : primaryStatus === "waiting"
                ? "Ready to reprint · already in queue"
                : "Ready to print · will check in"}
        </p>
        <p className="truncate text-base font-semibold">
          {isBatch
            ? labelBits || "Batch sheet"
            : `${primary?.regNo != null ? `#${primary.regNo}` : "Prescription"}${
                primary?.name ? ` · ${primary.name}` : ""
              }`}
        </p>
        <p className="text-xs text-muted">
          {isBatch
            ? "Browser cannot confirm print success. Keep this batch until paper is good, then Start next sheet."
            : primaryStatus === "seen"
              ? "Reprinting keeps the completed consultation status unchanged."
              : primaryStatus === "waiting"
                ? "The patient is already waiting for a doctor."
                : "Printing a pre-registered patient also checks them into the line."}
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
          {isPrinting
            ? "Preparing print…"
            : isBatch
              ? printedOnce
                ? "Reprint sheet"
                : "Print sheet"
              : primaryStatus === "seen"
                ? "Print completed form"
                : primaryStatus === "waiting"
                  ? "Reprint (1 page)"
                  : "Check in & print"}
        </Button>
        {isBatch ? (
          <Button
            type="button"
            variant="secondary"
            className="w-auto"
            onClick={startNextSheet}
            data-testid="print-start-next-sheet"
          >
            Start next sheet
          </Button>
        ) : null}
        <Link
          href={deskHref}
          className="inline-flex min-h-12 items-center justify-center rounded-xl border border-border bg-brand-soft px-4 text-sm font-semibold text-brand transition hover:bg-white"
        >
          {deskLabel}
        </Link>
        <Link
          href="/register"
          className="inline-flex min-h-12 items-center justify-center rounded-xl border border-border bg-white px-4 text-sm font-semibold text-foreground transition hover:bg-brand-soft"
        >
          Register next
        </Link>
      </div>
    </div>
  );
}
