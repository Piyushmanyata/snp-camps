"use client";

import dynamic from "next/dynamic";
import { Button, CollapsibleSection } from "@/components/ui";
import type { AadhaarScanner } from "@/components/use-aadhaar-scanner";

/** Keep the patient scanner flow out of the eager self-register route chunk. */
export const SelfRegistrationFlowLazy = dynamic(
  () =>
    import("@/components/self-registration-flow").then(
      (module) => ({ default: module.SelfRegistrationFlow }),
    ),
  {
    ssr: false,
    loading: () => (
      <p
        role="status"
        aria-live="polite"
        className="rounded-xl border border-border bg-background px-3 py-4 text-sm text-muted"
      >
        Registration load ho rahi hai…
      </p>
    ),
  },
);

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
    scan: "Live camera fallback",
    stop: "Stop scanner",
    photo: "Take full-resolution photo",
    gallery: "Choose existing photo",
    readingPhoto: "Reading photo…",
    aim: "Hold the Aadhaar QR inside the frame",
    preview: "Aadhaar QR camera preview",
    consentNote:
      "Details are extracted for autofill only. Aadhaar identity is not verified.",
    diagnosticTitle: "Card did not read fully — report this format",
    diagnosticBody:
      "This describes the QR's structure only. It contains no name, number, or address.",
    copyDiagnostic: "Copy",
    consent:
      "The patient has consented to extracting Aadhaar card details for registration.",
  },
  patient: {
    scan: "Live camera se try karein",
    stop: "Scanner band karein",
    photo: "Aadhaar ka photo lein",
    gallery: "Gallery se photo chunein",
    readingPhoto: "Photo padh rahe hain…",
    aim: "Aadhaar QR ko frame ke andar rakhein",
    preview: "Aadhaar QR camera ka preview",
    consentNote:
      "Details sirf form bharne ke liye li ja rahi hain. Aadhaar identity verify nahi hoti.",
    diagnosticTitle: "Card dobara scan karein",
    diagnosticBody: "QR details poori nahi padh paayi.",
    copyDiagnostic: "Copy",
    consent:
      "Main registration ke liye Aadhaar card ki details nikalne ki sahmati deta/deti hoon.",
  },
} as const;

/** Shared camera/photo Aadhaar capture surface for desk and self-registration. */
export function AadhaarCapture({ scanner, tone = "desk", diagnostic }: Props) {
  const copy = COPY[tone];
  const {
    isScanning,
    isReadingPhoto,
    hasConsent,
    scanError,
    videoRef,
    start,
    readPhoto,
    setConsent,
    stop,
  } = scanner;
  const shownDiagnostic = diagnostic ?? scanner.scanDiagnostic;
  const shownError =
    tone === "patient" && scanError
      ? "QR nahi padha. Dobara try karein ya camp desk par jaakar madad lein."
      : scanError;
  const visibleDiagnostic = tone === "patient" ? null : shownDiagnostic;

  return (
    <div className="space-y-3">
      <label className="flex min-h-12 items-start gap-3 rounded-xl border border-border bg-card px-3 py-3 text-sm font-semibold text-foreground">
        <input
          type="checkbox"
          className="mt-0.5 size-5 shrink-0"
          checked={hasConsent}
          onChange={(event) => setConsent(event.target.checked)}
          data-testid="aadhaar-consent"
        />
        <span>
          {copy.consent}
          <span className="mt-1 block text-xs font-normal text-muted">
            {copy.consentNote}
          </span>
        </span>
      </label>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex min-h-12 cursor-pointer items-center justify-center rounded-xl border border-brand bg-brand-soft px-4 py-2 text-sm font-semibold text-brand transition active:scale-[0.98] focus-within:outline focus-within:outline-3 focus-within:outline-offset-2 focus-within:outline-brand">
          <span>{isReadingPhoto ? copy.readingPhoto : copy.photo}</span>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            disabled={!hasConsent || isReadingPhoto}
            aria-label={copy.photo}
            data-testid="aadhaar-photo-input"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void readPhoto(file);
            }}
          />
        </label>

        <label className="flex min-h-12 cursor-pointer items-center justify-center rounded-xl border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground transition active:scale-[0.98] focus-within:outline focus-within:outline-3 focus-within:outline-offset-2 focus-within:outline-brand">
          <span>{isReadingPhoto ? copy.readingPhoto : copy.gallery}</span>
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            disabled={!hasConsent || isReadingPhoto}
            aria-label={copy.gallery}
            data-testid="aadhaar-gallery-input"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void readPhoto(file);
            }}
          />
        </label>
      </div>

      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="sm:w-auto"
        data-testid="scan-aadhaar-qr-button"
        aria-pressed={isScanning}
        disabled={!hasConsent || isReadingPhoto}
        onClick={isScanning ? stop : () => void start()}
      >
        {isScanning ? copy.stop : copy.scan}
      </Button>

      {isScanning ? (
        <div className="relative flex aspect-video max-h-64 items-center justify-center overflow-hidden rounded-xl bg-black">
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className="h-full w-full object-cover"
            aria-label={copy.preview}
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

      {visibleDiagnostic ? (
        <div data-testid="aadhaar-scan-diagnostic">
          <CollapsibleSection title={copy.diagnosticTitle}>
            <p className="text-sm text-muted">{copy.diagnosticBody}</p>
            <code className="mt-2 block break-all font-mono text-[11px]">
              {visibleDiagnostic}
            </code>
            <button
              type="button"
              className="mt-2 min-h-12 rounded-xl border border-border px-3 font-semibold"
              onClick={() => navigator.clipboard?.writeText(visibleDiagnostic)}
            >
              {copy.copyDiagnostic}
            </button>
          </CollapsibleSection>
        </div>
      ) : null}
    </div>
  );
}
