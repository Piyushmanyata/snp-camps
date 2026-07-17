"use client";

import Link from "next/link";
import { Button } from "@/components/ui";

export function PrintActions({
  className = "",
  regNo,
  name,
}: {
  className?: string;
  regNo?: number;
  name?: string;
}) {
  return (
    <div
      className={`flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between ${className}`}
    >
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-wide text-brand">
          Ready to print
        </p>
        <p className="truncate text-base font-semibold">
          {regNo != null ? `#${regNo}` : "Prescription"}
          {name ? ` · ${name}` : ""}
        </p>
        <p className="text-xs text-muted">Opening this page marks the patient as seen</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          className="w-auto min-w-[9rem]"
          onClick={() => window.print()}
        >
          Print (1 page)
        </Button>
        <Link
          href="/volunteer"
          className="inline-flex min-h-12 items-center justify-center rounded-xl border border-border bg-brand-soft px-4 text-sm font-semibold text-brand transition hover:bg-white"
        >
          Back to desk
        </Link>
      </div>
    </div>
  );
}
