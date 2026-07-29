"use client";

import { Button } from "@/components/ui";
import type { AadhaarScanner } from "@/components/use-aadhaar-scanner";

type Props = {
  scanner: AadhaarScanner;
  /** Hindi-Roman copy for patient self-registration; English for the desk. */
  tone?: "desk" | "patient";
  /**
   * Overrides the scanner's own fingerprint. The desk also reports *partial*
   * reads — a card that filled some fields but not others — which the scanner
   * itself does not treat as an error.
   */
  diagnostic?: string | null;
};

const COPY = {
  desk: {
    scan: "Scan Aadhaar QR",
    stop: "Stop scanner",
    photo: "Use Aadhaar photo",
    readingPhoto: "Reading photo…",
    aim: "Hold the Aadhaar QR inside the frame",
  },
  patient: {
    scan: "Aadhaar QR scan karein",
    stop: "Scanner band karein",
    photo: "Aadhaar photo chunein",
    readingPhoto: "Photo padh rahe hain…",
    aim: "Aadhaar QR ko frame ke andar rakhein",
  },
} as const;

/** Shared camera/photo Aadhaar capture surface for desk and self-registration. */
export function AadhaarCapture({ scanner, tone = "desk", diagnostic }: Props) {
  const copy = COPY[tone];
  const {
    isScanning,
    isReadingPhoto,
    scanError,
    videoRef,
    start,
    readPhoto,
    stop,
  } = scanner;
  const shownDiagnostic = diagnostic ?? scanner.scanDiagnostic;
  const shownError =
    tone === "patient" && scanError
      ? "QR nahi padha. Camera ya Aadhaar photo dobara try karein, ya details manually bharein."
      : scanError;

  return (
    <div className="space-y-3">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="sm:w-auto"
        data-testid="scan-aadhaar-qr-button"
        aria-pressed={isScanning}
        onClick={isScanning ? stop : () => void start()}
      >
        {isScanning ? copy.stop : copy.scan}
      </Button>

      <label className="flex min-h-12 cursor-pointer items-center justify-center rounded-xl border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground transition active:scale-[0.98] focus-within:outline focus-within:outline-3 focus-within:outline-offset-2 focus-within:outline-brand sm:inline-flex">
        <span>{isReadingPhoto ? copy.readingPhoto : copy.photo}</span>
        <input
          type="file"
          accept="image/*"
          className="sr-only"
          disabled={isReadingPhoto}
          aria-label={copy.photo}
          data-testid="aadhaar-photo-input"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void readPhoto(file);
          }}
        />
      </label>

      {isScanning ? (
        <div className="relative flex aspect-video max-h-64 items-center justify-center overflow-hidden rounded-xl bg-black">
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className="h-full w-full object-cover"
            aria-label="Aadhaar QR camera preview"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 m-4 flex items-center justify-center rounded-xl border-2 border-dashed border-white/60"
          >
            <span className="rounded-md bg-black/70 px-3 py-1 text-xs font-medium text-white">
              {copy.aim}
            </span>
          </div>
        </div>
      ) : null}

      {shownError ? (
        <div
          role="alert"
          data-testid="aadhaar-scan-error"
          className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs font-semibold text-red-950"
        >
          {shownError}
        </div>
      ) : null}

      {shownDiagnostic ? (
        <details
          data-testid="aadhaar-scan-diagnostic"
          className="rounded-xl border border-border px-3 py-2 text-xs text-muted"
        >
          <summary className="cursor-pointer font-semibold">
            Card did not read fully — report this format
          </summary>
          <p className="mt-2">
            This describes the QR&apos;s structure only. It contains no name,
            number, or address.
          </p>
          <code className="mt-2 block break-all font-mono text-[11px]">
            {shownDiagnostic}
          </code>
          <button
            type="button"
            className="mt-2 min-h-12 rounded-xl border border-border px-3 font-semibold"
            onClick={() => navigator.clipboard?.writeText(shownDiagnostic)}
          >
            Copy
          </button>
        </details>
      ) : null}
    </div>
  );
}
