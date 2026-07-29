"use client";

import { useCallback, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useFixedPoll } from "@/lib/poll";

/**
 * Keeps the patient status page current without a full page reload.
 *
 * This replaces `<meta http-equiv="refresh" content="30">`, which reloaded the
 * whole document on a timer the patient could not pause or extend — a WCAG 2.2
 * SC 2.2.1 failure that also restarted every screen reader mid-sentence.
 * `useFixedPoll` already pauses while the tab is hidden.
 */
export function StatusAutoRefresh({ ms = 30_000 }: { ms?: number }) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const refresh = useCallback(() => {
    startTransition(() => router.refresh());
  }, [router]);

  useFixedPoll(refresh, ms, true);
  return null;
}
