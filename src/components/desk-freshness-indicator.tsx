"use client";

import type { DeskLiveFreshness } from "@/lib/camp-desk-live";

export const STALE_DESK_INDICATOR =
  "Could not refresh — showing last known data. Try again.";

/** Visible when a desk poll failed while prior rows are still shown (#56). */
export function DeskFreshnessIndicator({
  freshness,
  onRetry,
}: {
  freshness: DeskLiveFreshness;
  onRetry?: () => void;
}) {
  if (freshness !== "stale-error") return null;
  return (
    <div
      role="status"
      className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-950"
    >
      <p>{STALE_DESK_INDICATOR}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="pressable min-h-10 rounded-lg border border-amber-300 bg-white px-3 py-1.5 font-semibold text-amber-950 hover:bg-amber-100"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}
