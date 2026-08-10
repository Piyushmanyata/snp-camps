"use client";

import {
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useState,
} from "react";

/**
 * Collapsible that only mounts children once opened (lazy island gate).
 * children is a render prop receiving `ready` after first open.
 * Re-exported from `@/components/ui` for the Phase 6 public API.
 */
export function OpenOnToggle({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: (ready: boolean) => ReactNode;
}) {
  const [ready, setReady] = useState(false);
  const onToggle = useCallback((e: SyntheticEvent<HTMLDetailsElement>) => {
    if (e.currentTarget.open) setReady(true);
  }, []);

  return (
    <details
      className="group rounded-2xl border border-border bg-card"
      onToggle={onToggle}
    >
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 marker:content-none [&::-webkit-details-marker]:hidden">
        <span className="text-lg font-semibold tracking-tight text-foreground">
          {title}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {hint ? (
            <span className="text-[0.8125rem] text-muted">{hint}</span>
          ) : null}
          <span
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-background text-muted transition-transform duration-150 group-open:rotate-180"
            aria-hidden="true"
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              className="h-4 w-4"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 6l4 4 4-4" />
            </svg>
          </span>
        </span>
      </summary>
      <div className="border-t border-border px-5 pb-5 pt-4">
        {children(ready)}
      </div>
    </details>
  );
}
