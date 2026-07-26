"use client";

import { useLayoutEffect, useRef } from "react";
import Link from "next/link";
import {
  a4BatchIds,
  a4BatchPreviewPath,
  readA4BatchFromStorage,
} from "@/lib/a4-batch-queue";

/**
 * When /print/batch is opened without ?ids=, recover from station localStorage
 * and redirect to the canonical preview URL (#64 reload recovery).
 *
 * Renders the empty state immediately; if storage has ids, replaces location
 * before paint when possible (layout effect) without cascading setState.
 */
export function BatchClientBootstrap({
  deskHref,
  deskLabel,
}: {
  deskHref: "/admin" | "/volunteer";
  deskLabel: string;
}) {
  const redirected = useRef(false);

  useLayoutEffect(() => {
    if (redirected.current) return;
    const queue = readA4BatchFromStorage();
    const ids = a4BatchIds(queue);
    if (ids.length === 0) return;
    redirected.current = true;
    window.location.replace(a4BatchPreviewPath(ids));
  }, []);

  return (
    <div
      className="rounded-2xl border border-border bg-card p-6 text-center"
      data-testid="a4-batch-empty"
    >
      <p className="text-lg font-semibold">No A4 batch on this station</p>
      <p className="mt-1 text-sm text-muted">
        Register patients in A4 mode to fill a multi-up sheet, or open a single
        patient print link.
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <Link
          href="/register"
          className="inline-flex min-h-12 items-center justify-center rounded-xl bg-brand px-4 text-sm font-semibold text-white"
        >
          Register
        </Link>
        <Link
          href={deskHref}
          className="inline-flex min-h-12 items-center justify-center rounded-xl border border-border px-4 text-sm font-semibold"
        >
          {deskLabel}
        </Link>
      </div>
    </div>
  );
}
