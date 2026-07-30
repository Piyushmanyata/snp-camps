"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ParsedAadhaarQr } from "@/lib/aadhaar-qr";
import { applyBestEffortCameraConstraints } from "@/lib/qr-detector";
import {
  AADHAAR_PROBES,
  probeSurface,
  type Probe,
} from "@/lib/qr-decode-geometry";
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
/** What the caller does with a decoded card. */
export type OnParsed = (
  parsed: ParsedAadhaarQr,
  diagnostic: string,
) => boolean | Promise<boolean>;

export type AadhaarScanner = {
  isScanning: boolean;
  isReadingPhoto: boolean;
  isReadingUsb: boolean;
  hasConsent: boolean;
  /** Operator-facing failure. Always names manual entry as the way forward. */
  scanError: string | null;
  /** Structure-only fingerprint of a problem payload — never patient data. */
  scanDiagnostic: string | null;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  start: () => Promise<void>;
  readPhoto: (file: File) => Promise<void>;
  readPayload: (payload: string) => Promise<void>;
  setConsent: (consented: boolean) => void;
  stop: () => void;
  clearError: () => void;
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
  const [isReadingPhoto, setIsReadingPhoto] = useState(false);
  const [isReadingUsb, setIsReadingUsb] = useState(false);
  const [hasConsent, setHasConsent] = useState(false);
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
    setIsReadingPhoto(false);
    setIsReadingUsb(false);
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
      if (outcome.status === "malformed") {
        setScanError(outcome.message);
        setScanDiagnostic(outcome.diagnostic);
        return false;
      }

      const accepted = await onParsedRef.current(
        outcome.parsed,
        outcome.diagnostic,
      );
      if (accepted) {
        setScanError(null);
        setScanDiagnostic(null);
        stop();
      } else {
        setScanDiagnostic(outcome.diagnostic);
        setScanError(
          `Card read was incomplete. Hold the QR steady and try again, or ${MANUAL_HINT.toLowerCase()}`,
        );
      }
      return accepted;
    },
    [stop],
  );

  const start = useCallback(async () => {
    if (!hasConsent) {
      setScanError("Record the patient's consent before extracting Aadhaar details.");
      return;
    }
    // Starting the camera supersedes any in-flight photo decode.
    setIsReadingPhoto(false);
    setScanError(null);
    setScanDiagnostic(null);
    setIsScanning(true);
    const token = sessionRef.current.begin();

    try {
      // Camera permission and decoder loading are independent. Starting both
      // together removes a full network/worker round trip from time-to-preview.
      const clientPromise = loadDecodeClient();
      const streamPromise = sessionRef.current.acquireFirstAvailable(
        token,
        (c) => navigator.mediaDevices.getUserMedia(c),
        [
          {
            video: {
              facingMode: { ideal: "environment" },
              // Dense Secure QR and tiny legacy QR are both pixel-starved; ask
              // for detail first, then retry without a size on broken OEMs.
              width: { ideal: 2560 },
              height: { ideal: 1440 },
            },
            audio: false,
          },
          {
            video: { facingMode: { ideal: "environment" } },
            audio: false,
          },
          { video: true, audio: false },
        ],
      );
      const [client, stream] = await Promise.all([
        clientPromise,
        streamPromise,
      ]);
      client.warmUpDecoder();

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
      let consecutiveDecodeErrors = 0;

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

              const image =
                probeImage(
                  AADHAAR_PROBES[frameTick % AADHAAR_PROBES.length],
                );
              if (image) {
                const outcome = await client.decodeFrame(image, thorough);
                consecutiveDecodeErrors = 0;
                if (!sessionRef.current.isCurrent(token)) return;
                if (await handleOutcome(outcome)) return;
              }
            }
          } catch {
            consecutiveDecodeErrors += 1;
            if (consecutiveDecodeErrors >= 3) {
              client.disposeDecoder();
              setScanError(
                `Scanner could not start on this phone. Use an Aadhaar photo, or ${MANUAL_HINT.toLowerCase()}`,
              );
              stop();
              return;
            }
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
    } catch {
      sessionRef.current.invalidate();
      setScanError(`Camera unavailable or permission denied. ${MANUAL_HINT}`);
      setIsScanning(false);
    }
  }, [handleOutcome, hasConsent, stop]);

  const readPhoto = useCallback(
    async (file: File) => {
      if (!hasConsent) {
        setScanError("Record consent before choosing an Aadhaar photo.");
        return;
      }
      stop();
      const token = sessionRef.current.begin();
      setScanError(null);
      setScanDiagnostic(null);
      setIsReadingPhoto(true);

      let bitmap: ImageBitmap | null = null;
      let objectUrl: string | null = null;
      try {
        if (!file.type.startsWith("image/")) {
          throw new Error("Please choose an image.");
        }

        let source: CanvasImageSource;
        let width: number;
        let height: number;

        if (typeof createImageBitmap === "function") {
          bitmap = await createImageBitmap(file, {
            imageOrientation: "from-image",
          })
            .catch(() => createImageBitmap(file));
          if (!sessionRef.current.isCurrent(token)) return;
          source = bitmap;
          width = bitmap.width;
          height = bitmap.height;
        } else {
          objectUrl = URL.createObjectURL(file);
          const image = new Image();
          image.src = objectUrl;
          await image.decode();
          if (!sessionRef.current.isCurrent(token)) return;
          source = image;
          width = image.naturalWidth;
          height = image.naturalHeight;
        }

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx || width < 40 || height < 40) {
          throw new Error("This photo could not be read.");
        }

        const client = await loadDecodeClient();
        for (const probe of AADHAAR_PROBES) {
          if (!sessionRef.current.isCurrent(token)) return;
          const surface = probeSurface(width, height, probe);
          if (!surface) continue;
          const { sx, sy, cw, ch, dw, dh } = surface;
          canvas.width = dw;
          canvas.height = dh;
          ctx.imageSmoothingEnabled = dw < cw;
          ctx.drawImage(source, sx, sy, cw, ch, 0, 0, dw, dh);
          const outcome = await client.decodeFrame(
            ctx.getImageData(0, 0, dw, dh),
            true,
          );
          if (!sessionRef.current.isCurrent(token)) return;
          if (outcome.status !== "none") {
            setIsReadingPhoto(false);
            await handleOutcome(outcome);
            return;
          }
        }

        if (!sessionRef.current.isCurrent(token)) return;
        setScanError(
          `No Aadhaar QR found in this photo. Take a closer, well-lit photo, or ${MANUAL_HINT.toLowerCase()}`,
        );
      } catch {
        if (!sessionRef.current.isCurrent(token)) return;
        setScanError(
          `Photo unavailable or unreadable. Try another photo, or ${MANUAL_HINT.toLowerCase()}`,
        );
      } finally {
        bitmap?.close();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        if (sessionRef.current.isCurrent(token)) setIsReadingPhoto(false);
      }
    },
    [handleOutcome, hasConsent, stop],
  );

  const readPayload = useCallback(
    async (payload: string) => {
      if (!hasConsent) {
        setScanError("Record consent before using the USB Aadhaar scanner.");
        return;
      }
      stop();
      setScanError(null);
      setScanDiagnostic(null);
      setIsReadingUsb(true);
      try {
        const client = await loadDecodeClient();
        await handleOutcome(await client.decodePayload(payload));
      } catch {
        setScanError("USB scanner payload could not be read. Scan the card again.");
      } finally {
        setIsReadingUsb(false);
      }
    },
    [handleOutcome, hasConsent, stop],
  );

  return {
    isScanning,
    isReadingPhoto,
    isReadingUsb,
    hasConsent,
    scanError,
    scanDiagnostic,
    videoRef,
    start,
    readPhoto,
    readPayload,
    setConsent: setHasConsent,
    stop,
    clearError,
  };
}
