"use client";

import { useEffect } from "react";

/** Fixed auto-refresh for queue/seats — not live realtime. */
export const POLL_MS = 120_000;

/** Tick every `ms` while visible. `ms <= 0` disables. */
export function useFixedPoll(
  tick: () => void | Promise<unknown>,
  ms: number,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled || ms <= 0) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void tick();
    }, ms);
    return () => window.clearInterval(id);
  }, [enabled, ms, tick]);
}
