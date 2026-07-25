"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, ErrorBox, Spinner } from "@/components/ui";

/**
 * Distinct from EmptyState: failed load, not "nothing here".
 * Retry re-runs the parent RSC tree for this section via router.refresh.
 */
export function SectionLoadError({
  message,
  retryLabel = "Retry",
}: {
  message: string;
  retryLabel?: string;
}) {
  const router = useRouter();
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
            router.refresh();
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
