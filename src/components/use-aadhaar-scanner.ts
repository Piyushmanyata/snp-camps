"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  parseAadhaarQrAsync,
  describeQrPayload,
  type ParsedAadhaarQr,
} from "@/lib/aadhaar-qr";
import {
  applyBestEffortCameraConstraints,
  canUseNativeQrDetector,
  getBarcodeDetectorConstructor,
  type BarcodeDetectorInstance,
  type JsQrFn,
  type JsQrOptions,
} from "@/lib/qr-detector";
import type { QrPayload } from "@/lib/qr-decode-pipeline";
import { QrCameraSession } from "@/lib/qr-camera-session";

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
 * pass. The cascade costs roughly 7x a cheap pass on a miss, so running it on
 * every frame both stalls the probe-geometry sweep and drops the effective frame
 * rate to a crawl. Interleaving keeps the cheap sweep live and still retries the
 * heavy passes several times a second.
 */
const THOROUGH_EVERY_N_FRAMES = 4;
/**
 * Probe geometries cycled one per frame, so all card sizes are covered within
 * ~4 frames without making any single frame expensive.
 *
 * The tight, upscaled probes exist for legacy pre-2018 cards: their QR is
 * printed far smaller than the modern Secure QR, so it occupies too few pixels
 * to resolve from the whole frame. Cropping in and upscaling is what makes
 * those cards readable at all.
 */
const LIVE_PROBES: { scale: number; zoom: number; offsetX?: number; offsetY?: number }[] = [
  { scale: 1, zoom: 1 },
  { scale: 0.6, zoom: 1 },
  { scale: 0.4, zoom: 2 },
  { scale: 0.25, zoom: 2 },
  { scale: 0.4, zoom: 2, offsetX: -0.15, offsetY: -0.15 },
  { scale: 0.4, zoom: 2, offsetX: 0.15, offsetY: 0.15 },
];
/** Live frames skip the inverted pass — roughly 2x faster, and Aadhaar is never inverted. */
const LIVE_JSQR_OPTIONS: JsQrOptions = { inversionAttempts: "dontInvert" };

/**
 * The decode pipeline (preprocessing + ZXing) is an optional island: it is only
 * reachable once the operator starts a scan, so it is deferred out of the
 * route entry chunk exactly like jsqr.
 */
type QrPipeline = typeof import("@/lib/qr-decode-pipeline");
let pipelinePromise: Promise<QrPipeline> | null = null;
function loadQrPipeline(): Promise<QrPipeline> {
  if (!pipelinePromise) {
    pipelinePromise = import("@/lib/qr-decode-pipeline");
  }
  return pipelinePromise;
}

let jsQrPromise: Promise<JsQrFn> | null = null;
function loadJsQr(): Promise<JsQrFn> {
  if (!jsQrPromise) {
    jsQrPromise = import("jsqr").then((m) => {
      const fn = (m as { default?: JsQrFn }).default ?? (m as unknown as JsQrFn);
      return fn;
    });
  }
  return jsQrPromise;
}

export type AadhaarScanner = {
  isScanning: boolean;
  /** Operator-facing failure. Always names manual entry as the way forward. */
  scanError: string | null;
  /** Structure-only fingerprint of a problem payload — never patient data. */
  scanDiagnostic: string | null;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  start: () => Promise<void>;
  stop: () => void;
  clearError: () => void;
};

/**
 * The single Aadhaar camera + decode loop, shared by the Volunteer Desk and
 * patient self-registration. #92 forbids a second scanner stack, and the probe
 * geometry and escalation schedule below are tuned against the device floor
 * documented in docs/barcodedetector-device-floor.md — duplicating them would
 * mean two implementations drifting apart on the cards that read worst.
 *
 * `onParsed` runs on a successfully decoded Aadhaar payload, with the raw
 * payload alongside it so a caller can fingerprint a partial read. Return true
 * to end the session; return false to keep the camera running (used when a
 * frame decoded but carried nothing worth filling in).
 */
export function useAadhaarScanner(
  onParsed: (
    parsed: ParsedAadhaarQr,
    payload: string | Uint8Array,
  ) => boolean | Promise<boolean>,
): AadhaarScanner {
  const [isScanning, setIsScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanDiagnostic, setScanDiagnostic] = useState<string | null>(null);
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
  }, []);

  useEffect(() => {
    const session = sessionRef.current;
    return () => {
      session.invalidate();
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, []);

  /**
   * Try one decoded payload. Returns true when the session should end.
   *
   * A payload that decoded but carried no usable field is not terminal — a
   * partial read on one blurry frame should not end the session when the next
   * frame may read cleanly. A non-Aadhaar payload (the app's own desk slip) is
   * terminal, because retrying will never help.
   */
  const handlePayload = useCallback(
    async (payload: string | Uint8Array): Promise<boolean> => {
      let parsed: ParsedAadhaarQr;
      try {
        parsed = await parseAadhaarQrAsync(payload);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Invalid Aadhaar QR code.";
        if (/desk slip/i.test(msg)) {
          setScanError(msg);
          setScanDiagnostic(describeQrPayload(payload));
          stop();
          return true;
        }
        return false;
      }

      const accepted = await onParsedRef.current(parsed, payload);
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
    setIsScanning(true);
    const token = sessionRef.current.begin();

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
      setScanError(
        "Camera unavailable or permission denied. Please type details manually.",
      );
      setIsScanning(false);
      return;
    }

    // Continuous autofocus is the single biggest factor in whether a dense
    // Aadhaar QR resolves at all.
    await applyBestEffortCameraConstraints(stream);

    // jsQR and ZXing both return usable byte payloads and each reads codes the
    // other misses; the platform detector is an extra fast path for clean cards.
    const pipeline = await loadQrPipeline();
    const [jsQR, zxing] = await Promise.all([
      loadJsQr().catch(() => undefined),
      pipeline.loadZxing(),
    ]);

    let detector: BarcodeDetectorInstance | undefined;
    if (await canUseNativeQrDetector()) {
      const Ctor = getBarcodeDetectorConstructor();
      if (Ctor) detector = new Ctor({ formats: ["qr_code"] });
    }

    if (!jsQR && !zxing && !detector) {
      setScanError("Scanner fallback unavailable. Please type details manually.");
      stop();
      return;
    }

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
     * Decode one probe geometry.
     *
     * Crops straight out of the video element in a single scaled drawImage, at a
     * size bounded by the pipeline's decode scale. Drawing the whole frame at
     * native camera resolution into intermediate canvases per probe costs three
     * full-resolution surfaces for a decode that gains nothing above ~8px per
     * QR module.
     */
    const decodeProbe = (
      probe: { scale: number; zoom: number; offsetX?: number; offsetY?: number },
      thorough: boolean,
    ): QrPayload | null => {
      if (!ctx || !video()) return null;
      const v = video()!;
      const cw = Math.floor(v.videoWidth * probe.scale);
      const ch = Math.floor(v.videoHeight * probe.scale);
      if (cw < 100 || ch < 100) return null;

      const sx = Math.max(
        0,
        Math.min(
          v.videoWidth - cw,
          Math.floor((v.videoWidth - cw) / 2 + (probe.offsetX || 0) * v.videoWidth),
        ),
      );
      const sy = Math.max(
        0,
        Math.min(
          v.videoHeight - ch,
          Math.floor((v.videoHeight - ch) / 2 + (probe.offsetY || 0) * v.videoHeight),
        ),
      );

      canvas.width = cw;
      canvas.height = ch;
      ctx.drawImage(v, sx, sy, cw, ch, 0, 0, cw, ch);

      const options = {
        jsQR,
        zxing,
        variants: thorough ? pipeline.THOROUGH_VARIANTS : pipeline.FAST_VARIANTS,
        jsQrOptions: LIVE_JSQR_OPTIONS,
      };

      // Upscale first when this probe is aimed at a small code. The cap ensures
      // we stay responsive even on high-res devices.
      if (probe.zoom > 1) {
        const bigger = pipeline.upscale(canvas, cw, ch, probe.zoom, pipeline.MAX_DECODE_EDGE);
        if (bigger) {
          const hit = pipeline.decodeImageMultiPass(bigger, options);
          if (hit) return hit;
        }
      }

      const data = ctx.getImageData(0, 0, cw, ch);
      return pipeline.decodeImageMultiPass(data, options);
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

            // Platform detector: cheap, and enough for legacy text-mode cards.
            if (detector) {
              try {
                const hits = await detector.detect(v);
                const raw = hits[0]?.rawValue;
                if (raw && (await handlePayload(raw))) return;
              } catch {
                /* ignore frame detect error */
              }
            }

            // Cycle the probe geometries so every card size gets covered within
            // a few frames, while each individual frame stays cheap. Once the
            // easy path has plainly failed (a faded photocopy), start mixing in
            // the full preprocessing cascade — but only on some frames. Making
            // every frame thorough pins the loop at the cascade's miss cost and
            // stalls the geometry sweep, so the operator waits seconds per probe.
            const thorough =
              frameTick > ESCALATE_AFTER_FRAMES &&
              frameTick % THOROUGH_EVERY_N_FRAMES === 0;
            const payload = decodeProbe(
              LIVE_PROBES[frameTick % LIVE_PROBES.length],
              thorough,
            );
            if (payload && (await handlePayload(payload))) return;
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
  }, [handlePayload, stop]);

  return { isScanning, scanError, scanDiagnostic, videoRef, start, stop, clearError };
}
