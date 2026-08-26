"use client";

import dynamic from "next/dynamic";
import { Button, CollapsibleSection } from "@/components/ui";
import type { AadhaarScanner } from "@/components/use-aadhaar-scanner";

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
        Loading registration…
      </p>
    ),
  },
);

type Props = {
  scanner: AadhaarScanner;
  tone?: "desk" | "patient";
  diagnostic?: string | null;
};

const COPY = {
  desk: {
    scan: "Try live camera",
    stop: "Stop scanner",
    photo: "Take photo to scan",
    gallery: "Choose photo from gallery",
    readingPhoto: "Reading photo…",
    aim: "Align Aadhaar QR inside the frame",
    preview: "Aadhaar QR camera preview",
    consentNote:
      "Details are used only to prefill the registration form. Aadhaar identity is not verified.",
    diagnosticTitle: "Card not fully read — report this format",
    diagnosticBody:
      "This contains only QR structure metadata. No name, number, or address.",
    copyDiagnostic: "Copy diagnostic",
    consent:
      "Patient consents to extracting details from their Aadhaar card for registration.",
  },
  patient: {
    scan: "Try live camera",
    stop: "Stop scanner",
    photo: "Take Aadhaar photo",
    gallery: "Choose photo from gallery",
    readingPhoto: "Reading photo…",
    aim: "Align Aadhaar QR inside the frame",
    preview: "Aadhaar QR camera preview",
    consentNote:
      "Details are used only to prefill the registration form. Aadhaar identity is not verified.",
    diagnosticTitle: "Scan card again",
    diagnosticBody: "Could not read complete QR details.",
    copyDiagnostic: "Copy",
    consent:
      "I consent to extracting details from my Aadhaar card for registration.",
  },
} as const;

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
      ? "Could not read QR code. Please try again or ask for help at the camp desk."
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
