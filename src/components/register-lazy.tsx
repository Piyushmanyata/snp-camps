"use client";

import dynamic from "next/dynamic";

/** Keep the secondary seat board out of the eager staff registration bundle. */
export const RegisterSeatBoardLazy = dynamic(
  () =>
    import("@/components/seat-board").then((module) => ({
      default: module.SeatBoard,
    })),
  {
    ssr: false,
    loading: () => (
      <p
        role="status"
        aria-live="polite"
        className="rounded-xl border border-border bg-background px-3 py-4 text-sm text-muted"
      >
        Loading seat board…
      </p>
    ),
  },
);
