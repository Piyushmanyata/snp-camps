"use client";

import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui";
import {
  A4_BATCH_MAX,
  a4BatchCount,
  a4BatchIds,
  a4BatchIsEmpty,
  a4BatchIsFull,
  a4BatchPreviewPath,
  a4BatchPrintPath,
  clearA4BatchStorage,
  getA4BatchServerSnapshot,
  readA4BatchFromStorage,
  subscribeA4Batch,
} from "@/lib/a4-batch-queue";

/**
 * Visible A4 station batch on the register desk (#64).
 * Shows 0–4 queued patient ids (uuid only), Print now / flush, Start next sheet.
 */
export function A4BatchPanel({
  lastRegNo,
}: {
  /** Optional last registration number for human flash context. */
  lastRegNo?: number | null;
}) {
  const queue = useSyncExternalStore(
    subscribeA4Batch,
    readA4BatchFromStorage,
    getA4BatchServerSnapshot,
  );

  if (a4BatchIsEmpty(queue)) return null;

  const ids = a4BatchIds(queue);
  const count = a4BatchCount(queue);
  const full = a4BatchIsFull(queue);

  function printNow() {
    window.open(a4BatchPrintPath(ids), "_blank");
  }

  function preview() {
    window.open(a4BatchPreviewPath(ids), "_blank");
  }

  function startNext() {
    clearA4BatchStorage();
  }

  return (
    <div
      className="rounded-xl border border-brand/25 bg-brand-soft/40 px-3 py-3"
      data-testid="a4-batch-panel"
      data-batch-count={count}
      data-batch-full={full ? "true" : "false"}
      data-batch-ids={ids.join(",")}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-brand">
            A4 sheet · {count} of {A4_BATCH_MAX} slips
            {full ? " · ready to print" : ""}
            {lastRegNo != null ? ` · last #${lastRegNo}` : ""}
          </p>
          <p className="text-xs text-muted">
            Distinct patients only. Empty cells stay empty. Batch stays until
            you Start next sheet after paper is good.
          </p>
          <ol className="mt-1 list-decimal pl-4 text-xs text-muted">
            {ids.map((id, i) => (
              <li key={id} data-testid="a4-batch-id" data-patient-id={id}>
                Slip {i + 1}: …{id.slice(-8)}
              </li>
            ))}
          </ol>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            className="sm:w-auto"
            data-testid="a4-batch-print-now"
            onClick={printNow}
          >
            {full ? "Print sheet" : "Print now"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="sm:w-auto"
            data-testid="a4-batch-preview"
            onClick={preview}
          >
            Preview
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="sm:w-auto"
            data-testid="a4-batch-clear"
            onClick={startNext}
          >
            Start next sheet
          </Button>
        </div>
      </div>
    </div>
  );
}
