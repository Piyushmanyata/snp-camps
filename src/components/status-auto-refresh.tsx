"use client";

import { useCallback, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useFixedPoll } from "@/lib/poll";

export function StatusAutoRefresh({ ms = 30_000 }: { ms?: number }) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const refresh = useCallback(() => {
    startTransition(() => router.refresh());
  }, [router]);

  useFixedPoll(refresh, ms, true);
  return null;
}
