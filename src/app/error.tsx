"use client";

import { useEffect } from "react";
import { Button, Card, Shell } from "@/components/ui";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Application route failed", {
      digest: error.digest,
      message: error.message,
    });
  }, [error]);

  return (
    <Shell title="Something went wrong" subtitle="Your previous action may not have completed.">
      <Card>
        <p className="text-sm text-muted">
          Check your connection and try again. If this keeps happening, show the
          desk team this reference:{" "}
          <span className="font-mono text-foreground">
            {error.digest || "unavailable"}
          </span>
        </p>
        <Button className="mt-4" onClick={reset}>
          Try again
        </Button>
      </Card>
    </Shell>
  );
}
