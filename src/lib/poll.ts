"use client";

import { useEffect } from "react";

/** Fixed auto-refresh for queue/seats — not live realtime. */
export const POLL_MS = 120_000;

/** Tick after each completed request while visible. `ms <= 0` disables. */
export function useFixedPoll(
  tick: () => void | Promise<unknown>,
  ms: number,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled || ms <= 0) return;

    let disposed = false;
    let timer: number | undefined;

    const schedule = () => {
      if (!disposed) timer = window.setTimeout(run, ms);
    };
    const run = async () => {
      if (disposed) return;
      if (document.visibilityState === "visible") {
        try {
          await tick();
        } catch {
          // A failed refresh must not disable future polling.
        }
      }
      schedule();
    };

    schedule();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [enabled, ms, tick]);
}
