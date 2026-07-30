"use client";

import { useTransition } from "react";
import { Button, ErrorBox, Spinner } from "@/components/ui";

/**
 * Distinct from EmptyState: failed load, not "nothing here" (#31, #63).
 * Retry must call a narrow section seam via `onRetry` — never a whole-route
 * refresh as the only recovery path.
 */
export function SectionLoadError({
  message,
  onRetry,
  retryLabel = "Retry",
}: {
  message: string;
  /** Narrow re-read for this section only. Required for the Retry control. */
  onRetry: () => void | Promise<void>;
  retryLabel?: string;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <div className="space-y-3 py-2" role="alert">
      <ErrorBox message={message} />
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="w-auto"
        disabled={pending}
        onClick={() => {
          startTransition(() => {
            void onRetry();
          });
        }}
      >
        {pending ? (
          <span className="inline-flex items-center gap-1.5">
            <Spinner className="h-3.5 w-3.5" />
            Retrying…
          </span>
        ) : (
          retryLabel
        )}
      </Button>
    </div>
  );
}
