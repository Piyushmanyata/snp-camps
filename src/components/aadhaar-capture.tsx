"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
    aim: "Point camera at the Aadhaar QR code",
    upload: "Upload photo",
    pdf: "Upload e-Aadhaar PDF",
    cropPrompt: "Drag a box around just the QR square, then release.",
    cropRetry: "Crop to the QR",
    working: "Reading…",
    password: "PDF password (share code)",
    passwordOpen: "Open PDF",
  },
  patient: {
    scan: "Aadhaar QR scan karein",
    stop: "Scanner band karein",
    aim: "Camera ko Aadhaar QR ke saamne rakhein",
    upload: "Photo upload karein",
    pdf: "e-Aadhaar PDF upload karein",
    cropPrompt: "Sirf QR ke around box banayein, phir chhod dein.",
    cropRetry: "QR par crop karein",
    working: "Padh rahe hain…",
    password: "PDF ka password (share code)",
    passwordOpen: "PDF kholein",
  },
} as const;

type Box = { x: number; y: number; width: number; height: number };

/**
 * Every way an Aadhaar card can reach the decoder.
 *
 * The upload paths are not a convenience — they are the only route for patient
 * self-registration, because a phone cannot point its own camera at a QR that
 * is displayed on that same phone. A patient holding an mAadhaar screenshot or
 * an e-Aadhaar PDF has no camera option at all.
 */
export function AadhaarCapture({ scanner, tone = "desk", diagnostic }: Props) {
  const copy = COPY[tone];
  const {
    isScanning,
    isBusy,
    scanError,
    videoRef,
    start,
    stop,
    scanFile,
    scanCrop,
    needsPdfPassword,
  } = scanner;
  const shownDiagnostic = diagnostic ?? scanner.scanDiagnostic;

  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const pdfInputRef = useRef<HTMLInputElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  /** The last failed upload, kept so the operator can crop it rather than retake. */
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [pendingPdf, setPendingPdf] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [box, setBox] = useState<Box | null>(null);
  /**
   * Displayed pixels per natural pixel. Kept in state rather than read off the
   * ref at render time: the crop box has to be stored in *natural* pixels (that
   * is what the decoder crops), but drawn in displayed pixels.
   */
  const [displayScale, setDisplayScale] = useState(1);
  const dragStart = useRef<{ x: number; y: number } | null>(null);

  // An object URL held past its usefulness leaks the whole decoded image.
  useEffect(() => {
    return () => {
      if (cropSrc) URL.revokeObjectURL(cropSrc);
    };
  }, [cropSrc]);

  const onPhoto = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setBox(null);
      const ok = await scanFile(file);
      if (ok) {
        setCropSrc(null);
        return;
      }
      // Automatic localisation failed — offer the manual crop on this image.
      // Only images can be cropped; a PDF has no single frame to draw on.
      if (file.type.startsWith("image/")) {
        setCropSrc((previous) => {
          if (previous) URL.revokeObjectURL(previous);
          return URL.createObjectURL(file);
        });
      }
    },
    [scanFile],
  );

  const onPdf = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setPendingPdf(file);
      const ok = await scanFile(file);
      if (ok) setPendingPdf(null);
    },
    [scanFile],
  );

  const openProtectedPdf = useCallback(async () => {
    if (!pendingPdf || !password) return;
    const ok = await scanFile(pendingPdf, password);
    if (ok) {
      setPendingPdf(null);
      setPassword("");
    }
  }, [pendingPdf, password, scanFile]);

  /** Map a pointer event onto natural image pixels, not displayed CSS pixels. */
  const toImagePoint = (event: React.PointerEvent<HTMLImageElement>) => {
    const image = imageRef.current;
    if (!image) return null;
    const rect = image.getBoundingClientRect();
    const scaleX = image.naturalWidth / rect.width;
    const scaleY = image.naturalHeight / rect.height;
    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
    };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLImageElement>) => {
    // Re-measure on every drag: the phone may have been rotated since load.
    measure(event.currentTarget);
    const point = toImagePoint(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStart.current = point;
    setBox({ x: point.x, y: point.y, width: 0, height: 0 });
  };

  const onPointerMove = (event: React.PointerEvent<HTMLImageElement>) => {
    if (!dragStart.current) return;
    const point = toImagePoint(event);
    if (!point) return;
    const start = dragStart.current;
    setBox({
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y),
    });
  };

  const onPointerUp = async () => {
    dragStart.current = null;
    const image = imageRef.current;
    // Ignore a stray tap: a box that small is never a QR selection.
    if (!image || !box || box.width < 24 || box.height < 24) return;
    const ok = await scanCrop(image, box);
    if (ok) setCropSrc(null);
  };

  const displayBox = box
    ? {
        left: box.x * displayScale,
        top: box.y * displayScale,
        width: box.width * displayScale,
        height: box.height * displayScale,
      }
    : null;

  /** Recompute after load and on any resize/rotation of the device. */
  const measure = (image: HTMLImageElement | null) => {
    if (!image?.naturalWidth) return;
    setDisplayScale(image.getBoundingClientRect().width / image.naturalWidth);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="sm:w-auto"
          data-testid="scan-aadhaar-qr-button"
          disabled={isBusy}
          onClick={isScanning ? stop : () => void start()}
        >
          {isScanning ? copy.stop : copy.scan}
        </Button>

        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="sm:w-auto"
          data-testid="aadhaar-upload-photo"
          disabled={isBusy}
          onClick={() => photoInputRef.current?.click()}
        >
          {copy.upload}
        </Button>

        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="sm:w-auto"
          data-testid="aadhaar-upload-pdf"
          disabled={isBusy}
          onClick={() => pdfInputRef.current?.click()}
        >
          {copy.pdf}
        </Button>
      </div>

      {/* `capture` is deliberately absent: the file picker must also offer the
          gallery, which is where a screenshot of mAadhaar lives. */}
      <input
        ref={photoInputRef}
        type="file"
        accept="image/*,.heic,.heif"
        className="sr-only"
        onChange={(event) => {
          void onPhoto(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      <input
        ref={pdfInputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="sr-only"
        onChange={(event) => {
          void onPdf(event.target.files?.[0]);
          event.target.value = "";
        }}
      />

      {isBusy ? (
        <p role="status" className="text-sm font-semibold text-brand">
          {copy.working}
        </p>
      ) : null}

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
          <div className="pointer-events-none absolute inset-0 m-4 flex items-center justify-center rounded-xl border-2 border-dashed border-white/60">
            <span className="rounded-md bg-black/60 px-3 py-1 text-xs font-medium text-white">
              {copy.aim}
            </span>
          </div>
        </div>
      ) : null}

      {needsPdfPassword && pendingPdf ? (
        <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3">
          <label
            htmlFor="aadhaar-pdf-password"
            className="text-sm font-semibold text-amber-950"
          >
            {copy.password}
          </label>
          <input
            id="aadhaar-pdf-password"
            type="password"
            autoComplete="off"
            className="min-h-12 w-full rounded-xl border border-border px-3"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Button
            type="button"
            size="sm"
            className="sm:w-auto"
            disabled={isBusy || !password}
            onClick={() => void openProtectedPdf()}
          >
            {copy.passwordOpen}
          </Button>
        </div>
      ) : null}

      {cropSrc ? (
        <div className="space-y-2 rounded-xl border border-border p-3">
          <p className="text-sm font-semibold">{copy.cropRetry}</p>
          <p className="text-xs text-muted">{copy.cropPrompt}</p>
          <div className="relative inline-block max-w-full touch-none">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imageRef}
              src={cropSrc}
              alt=""
              className="max-h-80 w-auto max-w-full cursor-crosshair select-none rounded-lg"
              draggable={false}
              onLoad={(event) => measure(event.currentTarget)}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={() => void onPointerUp()}
            />
            {displayBox ? (
              <div
                className="pointer-events-none absolute border-2 border-brand bg-brand/10"
                style={displayBox}
              />
            ) : null}
          </div>
        </div>
      ) : null}

      {scanError ? (
        <div
          role="alert"
          data-testid="aadhaar-scan-error"
          className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs font-semibold text-red-950"
        >
          {scanError}
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
