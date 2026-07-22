"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui";
import type { QueueStatus } from "@/lib/types";

export function PrintActions({
  className = "",
  patientId,
  regNo,
  name,
  queueStatus: initialQueueStatus,
  deskHref,
  deskLabel,
}: {
  className?: string;
  patientId: string;
  regNo?: number;
  name?: string;
  queueStatus: QueueStatus;
  deskHref: "/admin" | "/volunteer";
  deskLabel: "Admin dashboard" | "Volunteer desk";
}) {
  const [isPrinting, setIsPrinting] = useState(false);
  const [queueStatus, setQueueStatus] = useState(initialQueueStatus);
  const [message, setMessage] = useState<{
    tone: "error" | "success";
    text: string;
  } | null>(null);

  async function handlePrint() {
    setIsPrinting(true);
    setMessage(null);

    try {
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
        throw new Error(payload.error || "Could not add the patient to the queue.");
      }

      const nextStatus =
        payload.queueStatus === "seen" || payload.queueStatus === "waiting"
          ? payload.queueStatus
          : queueStatus === "seen"
            ? "seen"
            : "waiting";
      setQueueStatus(nextStatus);
      setMessage({
        tone: "success",
        text:
          nextStatus === "seen"
            ? "Completed consultation confirmed. The print dialog is open."
            : payload.alreadyPrinted
              ? "Queue confirmed. The print dialog is open."
              : "Patient added to the queue. The print dialog is open.",
      });
      window.print();
    } catch (error) {
      setMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "Could not prepare the print. Please try again.",
      });
    } finally {
      setIsPrinting(false);
    }
  }

  return (
    <div
      className={`flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between ${className}`}
    >
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-wide text-brand">
          {queueStatus === "seen"
            ? "Ready to print · consultation complete"
            : queueStatus === "waiting"
              ? "Ready to reprint · already in queue"
              : "Ready to print · queue not updated yet"}
        </p>
        <p className="truncate text-base font-semibold">
          {regNo != null ? `#${regNo}` : "Prescription"}
          {name ? ` · ${name}` : ""}
        </p>
        <p className="text-xs text-muted">
          {queueStatus === "seen"
            ? "Reprinting keeps the completed consultation status unchanged."
            : queueStatus === "waiting"
              ? "The patient is already waiting for a doctor."
              : "The queue updates only after you press the print button."}
        </p>
        {message ? (
          <p
            id="print-action-status"
            className={`mt-2 text-sm font-medium ${
              message.tone === "error" ? "text-red-700" : "text-emerald-700"
            }`}
            role={message.tone === "error" ? "alert" : "status"}
          >
            {message.text}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          className="w-auto min-w-[9rem]"
          disabled={isPrinting}
          aria-busy={isPrinting}
          aria-describedby={message ? "print-action-status" : undefined}
          onClick={handlePrint}
        >
          {isPrinting
            ? "Preparing print…"
            : queueStatus === "seen"
              ? "Print completed form"
              : queueStatus === "waiting"
                ? "Reprint (1 page)"
                : "Join queue & print"}
        </Button>
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
