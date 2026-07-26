"use client";

import { useEffect } from "react";

/**
 * Fixed auto-refresh interval for queue/seats when polling is active.
 * Staff desks use Realtime primarily (#25/#26); this interval is the
 * reconnect safety net and any non-live poll path (#53: ~20s).
 */
export const POLL_MS = 20_000;

/** Tick after each completed request while visible. `ms <= 0` disables. */
export function useFixedPoll(
  tick: () => void | Promise<unknown>,
  ms: number,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled || ms <= 0) return;

    let disposed = false;
    let running = false;
    let timer: number | undefined;

    const schedule = () => {
      if (disposed) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(run, ms);
    };
    const run = async () => {
      if (disposed || running) return;
      timer = undefined;
      if (document.visibilityState !== "visible") {
        schedule();
        return;
      }
      running = true;
      try {
        await tick();
      } catch {
        // A failed refresh must not disable future polling.
      } finally {
        running = false;
        schedule();
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible" || disposed) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      void run();
    };

    schedule();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, ms, tick]);
}
