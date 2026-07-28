"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ParsedAadhaarQr } from "@/lib/aadhaar-qr";
import { applyBestEffortCameraConstraints } from "@/lib/qr-detector";
import { probeSurface, type Probe } from "@/lib/qr-decode-geometry";
import { QrCameraSession } from "@/lib/qr-camera-session";
import type { DecodeOutcome } from "@/lib/aadhaar-decode-client";

/**
 * The decode client is an optional island, loaded only once the operator
 * actually starts a scan.
 *
 * It must not be imported statically: it constructs the decode Worker from a
 * `new URL(…, import.meta.url)` that the bundler resolves at build time, which
 * puts the worker's whole graph (Comlink, the parser, zod) into this route's
 * synchronous chunk set and blows the per-route JS budget (#71). Deferring the
 * import keeps the route entry thin and costs nothing: by the time a frame
 * needs decoding, the module has long since resolved.
 */
type DecodeClient = typeof import("@/lib/aadhaar-decode-client");
let decodeClientPromise: Promise<DecodeClient> | null = null;

function loadDecodeClient(): Promise<DecodeClient> {
  if (!decodeClientPromise) {
    decodeClientPromise = import("@/lib/aadhaar-decode-client");
  }
  return decodeClientPromise;
}

/** Dense Aadhaar QR needs pixels; cap decode work to keep the loop responsive. */
const SCAN_FPS = 12;
const SCAN_FRAME_INTERVAL_MS = 1000 / SCAN_FPS;
/**
 * Frames spent on the cheap path before escalating to the full preprocessing
 * cascade. Clean originals read almost immediately; a photocopy needs the
 * heavier passes, so we pay for them only once the easy path has clearly failed.
 */
const ESCALATE_AFTER_FRAMES = 12;
/**
 * Once escalated, how often a frame runs the full cascade rather than the cheap
 * pass. The cascade costs several times a cheap pass on a miss, so running it on
 * every frame both stalls the probe-geometry sweep and drops the effective frame
 * rate to a crawl. Interleaving keeps the cheap sweep live and still retries the
 * heavy passes several times a second.
 */
const THOROUGH_EVERY_N_FRAMES = 4;
/**
 * Probe geometries cycled one per frame, so all card sizes are covered within
 * ~6 frames without making any single frame expensive.
 *
 * The tight, upscaled probes exist for legacy pre-2018 cards: their QR is
 * printed far smaller than the modern Secure QR, so it occupies too few pixels
 * to resolve from the whole frame. Cropping in and upscaling is what makes
 * those cards readable at all.
 */
const LIVE_PROBES: Probe[] = [
  { scale: 1, zoom: 1 },
  { scale: 0.6, zoom: 1 },
  { scale: 0.4, zoom: 2 },
  { scale: 0.25, zoom: 2 },
  { scale: 0.4, zoom: 2, offsetX: -0.15, offsetY: -0.15 },
  { scale: 0.4, zoom: 2, offsetX: 0.15, offsetY: 0.15 },
];

/** What the caller does with a decoded card. */
export type OnParsed = (
  parsed: ParsedAadhaarQr,
  diagnostic: string,
) => boolean | Promise<boolean>;

export type AadhaarScanner = {
  isScanning: boolean;
  /** True while a still image (upload / PDF / crop) is being worked on. */
  isBusy: boolean;
  /** Operator-facing failure. Always names manual entry as the way forward. */
  scanError: string | null;
  /** Structure-only fingerprint of a problem payload — never patient data. */
  scanDiagnostic: string | null;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  start: () => Promise<void>;
  stop: () => void;
  clearError: () => void;
  /** Decode an uploaded photo, screenshot, HEIC, or e-Aadhaar PDF. */
  scanFile: (file: File, pdfPassword?: string) => Promise<boolean>;
  /** Decode a user-drawn crop after automatic localisation failed. */
  scanCrop: (
    source: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
    rect: { x: number; y: number; width: number; height: number },
  ) => Promise<boolean>;
  /** True when the last PDF needed a password. */
  needsPdfPassword: boolean;
};

const MANUAL_HINT = "Please type the details manually.";

/**
 * The single Aadhaar camera + decode entry point, shared by the Volunteer Desk
 * and patient self-registration. #92 forbids a second scanner stack, and the
 * probe geometry and escalation schedule below are tuned against the device
 * floor documented in docs/barcodedetector-device-floor.md — duplicating them
 * would mean two implementations drifting apart on the cards that read worst.
 *
 * All decoding happens in a worker; this hook only owns the camera, the frame
 * clock, and the probe geometry.
 *
 * `onParsed` runs on a successfully decoded Aadhaar payload. Return true to end
 * the session; return false to keep going (used when a frame decoded but
 * carried nothing worth filling in).
 */
export function useAadhaarScanner(onParsed: OnParsed): AadhaarScanner {
  const [isScanning, setIsScanning] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanDiagnostic, setScanDiagnostic] = useState<string | null>(null);
  const [needsPdfPassword, setNeedsPdfPassword] = useState(false);
  const sessionRef = useRef(new QrCameraSession());
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const animFrameRef = useRef<number | null>(null);

  // Keep the latest callback without restarting the camera when a parent
  // re-renders with a new closure.
  const onParsedRef = useRef(onParsed);
  useEffect(() => {
    onParsedRef.current = onParsed;
  }, [onParsed]);

  const stop = useCallback(() => {
    sessionRef.current.invalidate();
    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsScanning(false);
  }, []);

  const clearError = useCallback(() => {
    setScanError(null);
    setScanDiagnostic(null);
    setNeedsPdfPassword(false);
  }, []);

  useEffect(() => {
    const session = sessionRef.current;
    return () => {
      session.invalidate();
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
      }
      // The WASM engines hold tens of megabytes; the low-end Androids these
      // camps run on notice when that is not given back. Only meaningful if a
      // scan actually loaded the client.
      void decodeClientPromise?.then((client) => client.disposeDecoder());
    };
  }, []);

  /**
   * Apply one decode outcome. Returns true when the session should end.
   *
   * A payload that decoded but carried no usable field is not terminal — a
   * partial read on one blurry frame should not end the session when the next
   * frame may read cleanly. A non-Aadhaar payload (the app's own desk slip) is
   * terminal, because retrying will never help.
   */
  const handleOutcome = useCallback(
    async (outcome: DecodeOutcome): Promise<boolean> => {
      if (outcome.status === "none") return false;

      if (outcome.status === "rejected") {
        setScanError(outcome.message);
        setScanDiagnostic(outcome.diagnostic);
        stop();
        return true;
      }

      const accepted = await onParsedRef.current(
        outcome.parsed,
        outcome.diagnostic,
      );
      if (accepted) {
        setScanError(null);
        stop();
      }
      return accepted;
    },
    [stop],
  );

  const start = useCallback(async () => {
    setScanError(null);
    setNeedsPdfPassword(false);
    setIsScanning(true);
    const token = sessionRef.current.begin();

    // Load the client and warm the engines while the operator lines up the card.
    const client = await loadDecodeClient();
    client.warmUpDecoder();

    const stream = await sessionRef.current.acquire(
      token,
      (c) => navigator.mediaDevices.getUserMedia(c),
      {
        video: {
          facingMode: { ideal: "environment" },
          // Dense Secure QR and tiny legacy QR are both pixel-starved; ask for
          // the most the device will give and let it fall back on its own.
          width: { ideal: 2560 },
          height: { ideal: 1440 },
        },
        audio: false,
      },
    );

    if (!stream || !sessionRef.current.isCurrent(token)) {
      setScanError(`Camera unavailable or permission denied. ${MANUAL_HINT}`);
      setIsScanning(false);
      return;
    }

    // Continuous autofocus is the single biggest factor in whether a dense
    // Aadhaar QR resolves at all.
    await applyBestEffortCameraConstraints(stream);

    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      await videoRef.current.play().catch(() => {});
    }

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    let frameTick = 0;
    let lastFrameAt = 0;
    let busy = false;

    function video(): HTMLVideoElement | null {
      return videoRef.current;
    }

    /**
     * Grab one probe geometry as a bounded ImageData.
     *
     * ONE bounded surface per probe. Decoding the crop at native camera
     * resolution costs seconds per frame on a mid-range phone, which reads to
     * the operator as a frozen scanner — this has regressed twice, so
     * `probeSurface` owns the bound and is asserted by
     * tests/qr-decode-surface.test.mjs.
     */
    const probeImage = (probe: Probe): ImageData | null => {
      if (!ctx || !video()) return null;
      const v = video()!;
      const surface = probeSurface(v.videoWidth, v.videoHeight, probe);
      if (!surface) return null;
      const { sx, sy, cw, ch, dw, dh } = surface;

      canvas.width = dw;
      canvas.height = dh;
      // Hard module edges when magnifying; smooth when shrinking, which
      // averages sensor noise away instead of aliasing it into the modules.
      ctx.imageSmoothingEnabled = dw < cw;
      ctx.drawImage(v, sx, sy, cw, ch, 0, 0, dw, dh);
      return ctx.getImageData(0, 0, dw, dh);
    };

    const processFrame = async () => {
      if (!sessionRef.current.isCurrent(token) || !video()) return;

      const now = performance.now();
      // Throttle: an unthrottled rAF loop ran full-resolution decodes at 60fps,
      // starving the camera and making scanning slower, not faster.
      if (!busy && now - lastFrameAt >= SCAN_FRAME_INTERVAL_MS) {
        lastFrameAt = now;
        busy = true;
        try {
          const v = video()!;
          if (v.readyState >= 2 && v.videoWidth > 0) {
            frameTick += 1;

            // Cycle the probe geometries so every card size gets covered within
            // a few frames, while each individual frame stays cheap. Once the
            // easy path has plainly failed (a faded photocopy), start mixing in
            // the full preprocessing cascade — but only on some frames. Making
            // every frame thorough pins the loop at the cascade's miss cost and
            // stalls the geometry sweep, so the operator waits seconds per probe.
            const thorough =
              frameTick > ESCALATE_AFTER_FRAMES &&
              frameTick % THOROUGH_EVERY_N_FRAMES === 0;

            const image = probeImage(LIVE_PROBES[frameTick % LIVE_PROBES.length]);
            if (image) {
              const outcome = await client.decodeFrame(image, thorough);
              if (!sessionRef.current.isCurrent(token)) return;
              if (await handleOutcome(outcome)) return;
            }
          }
        } catch {
          /* keep scanning */
        } finally {
          busy = false;
        }
      }

      if (sessionRef.current.isCurrent(token)) {
        animFrameRef.current = requestAnimationFrame(() => {
          void processFrame();
        });
      }
    };

    animFrameRef.current = requestAnimationFrame(() => {
      void processFrame();
    });
  }, [handleOutcome]);

  const scanFile = useCallback(
    async (file: File, pdfPassword?: string): Promise<boolean> => {
      setIsBusy(true);
      setScanError(null);
      setNeedsPdfPassword(false);
      try {
        const { decodeFile } = await loadDecodeClient();
        const outcome = await decodeFile(file, { pdfPassword });
        if (outcome.status === "none") {
          setScanError(
            `No Aadhaar QR could be read from that file. Try a sharper photo, crop to the QR, or ${MANUAL_HINT.toLowerCase()}`,
          );
          return false;
        }
        return await handleOutcome(outcome);
      } catch (error: unknown) {
        if ((error as { name?: string })?.name === "PdfPasswordRequired") {
          setNeedsPdfPassword(true);
          setScanError((error as Error).message);
          return false;
        }
        setScanError(
          error instanceof Error ? error.message : `Could not read that file. ${MANUAL_HINT}`,
        );
        return false;
      } finally {
        setIsBusy(false);
      }
    },
    [handleOutcome],
  );

  const scanCrop = useCallback(
    async (
      source: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
      rect: { x: number; y: number; width: number; height: number },
    ): Promise<boolean> => {
      setIsBusy(true);
      setScanError(null);
      try {
        const { decodeCrop } = await loadDecodeClient();
        const outcome = await decodeCrop(source, rect);
        if (outcome.status === "none") {
          setScanError(
            `That crop still did not read. Try selecting just the QR square, or ${MANUAL_HINT.toLowerCase()}`,
          );
          return false;
        }
        return await handleOutcome(outcome);
      } catch {
        setScanError(`Could not read that crop. ${MANUAL_HINT}`);
        return false;
      } finally {
        setIsBusy(false);
      }
    },
    [handleOutcome],
  );

  return {
    isScanning,
    isBusy,
    scanError,
    scanDiagnostic,
    videoRef,
    start,
    stop,
    clearError,
    scanFile,
    scanCrop,
    needsPdfPassword,
  };
}
