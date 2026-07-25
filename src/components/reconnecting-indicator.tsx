"use client";

import { RECONNECTING_INDICATOR } from "@/lib/camp-desk-realtime";

/** Hard requirement of #25 — never silently degrade to stale poll data. */
export function ReconnectingIndicator({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <p
      role="status"
      className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-950"
    >
      {RECONNECTING_INDICATOR}
    </p>
  );
}
