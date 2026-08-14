"use client";

import { useTransition } from "react";
import { Button, ErrorBox, Spinner } from "@/components/ui";

export function SectionLoadError({
  message,
  onRetry,
  retryLabel = "Retry",
}: {
  message: string;
  onRetry: () => void | Promise<void>;
  retryLabel?: string;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <div className="space-y-3 py-2">
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
