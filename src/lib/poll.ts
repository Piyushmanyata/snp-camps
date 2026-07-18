"use client";

import { useEffect } from "react";

/** Fixed auto-refresh for queue/seats — not live realtime. */
export const POLL_MS = 120_000;

/**
 * Tick every `ms` while the tab is visible. No focus/visibility thrash.
 * Manual refresh stays on the component. `ms <= 0` disables auto poll.
 */
export function useFixedPoll(
  tick: () => void | Promise<unknown>,
  ms: number,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled || ms <= 0) return;
    let cancelled = false;
    let timer = 0;

    const schedule = () => {
      timer = window.setTimeout(async () => {
        if (cancelled) return;
        if (document.visibilityState === "visible") {
          try {
            await tick();
          } catch {
            /* keep schedule even if one tick fails */
          }
        }
        schedule();
      }, ms);
    };
    schedule();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [enabled, ms, tick]);
}
