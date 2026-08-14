"use client";

import type { DeskLiveFreshness } from "@/lib/camp-desk-live";

export const STALE_DESK_INDICATOR =
  "Could not refresh — showing last known data. Try again.";

export const FAILED_DESK_INDICATOR =
  "Could not load live data. Try again.";

export function DeskFreshnessIndicator({
  freshness,
  onRetry,
  hasKnownData = true,
}: {
  freshness: DeskLiveFreshness;
  onRetry?: () => void;
  hasKnownData?: boolean;
}) {
  if (freshness !== "stale-error" && freshness !== "error") return null;

  const isHardError = freshness === "error" || !hasKnownData;
  const copy = isHardError ? FAILED_DESK_INDICATOR : STALE_DESK_INDICATOR;

  return (
    <div
      role={isHardError ? "alert" : "status"}
      className={
        isHardError
          ? "mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-950"
          : "mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-950"
      }
    >
      <p>{copy}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className={
            isHardError
              ? "pressable min-h-12 min-w-12 rounded-lg border border-red-300 bg-white px-3 py-2 font-semibold text-red-950 hover:bg-red-100"
              : "pressable min-h-12 min-w-12 rounded-lg border border-amber-300 bg-white px-3 py-2 font-semibold text-amber-950 hover:bg-amber-100"
          }
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}
