"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ParsedAadhaarQr } from "@/lib/aadhaar-qr";
import {
  applyBestEffortCameraConstraints,
  canUseNativeQrDetector,
  getBarcodeDetectorConstructor,
  type BarcodeDetectorInstance,
} from "@/lib/qr-detector";
import {
  AADHAAR_PROBES,
  probeSurface,
  type Probe,
} from "@/lib/qr-decode-geometry";
import { QrCameraSession } from "@/lib/qr-camera-session";
import {
  attemptAadhaarDecode,
  type DecodeOutcome,
} from "@/lib/aadhaar-attempt";

type DecodeClient = typeof import("@/lib/aadhaar-decode-client");
let decodeClientPromise: Promise<DecodeClient> | null = null;

function loadDecodeClient(): Promise<DecodeClient> {
  if (!decodeClientPromise) {
    decodeClientPromise = import("@/lib/aadhaar-decode-client");
  }
  return decodeClientPromise;
}

const SCAN_FPS = 12;
const SCAN_FRAME_INTERVAL_MS = 1000 / SCAN_FPS;
const ESCALATE_AFTER_FRAMES = 12;
const THOROUGH_EVERY_N_FRAMES = 4;
export type OnParsed = (
  parsed: ParsedAadhaarQr,
  diagnostic: string,
) => boolean | Promise<boolean>;

export type AadhaarScanner = {
  isScanning: boolean;
  isReadingPhoto: boolean;
  isReadingUsb: boolean;
  hasConsent: boolean;
  scanError: string | null;
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

async function createNativeQrDetector(): Promise<BarcodeDetectorInstance | null> {
  try {
    const ok = await canUseNativeQrDetector();
    if (!ok) return null;
    const Ctor = getBarcodeDetectorConstructor();
    if (!Ctor) return null;
    return new Ctor({ formats: ["qr_code"] });
  } catch {
    return null;
  }
}

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
      void decodeClientPromise?.then((client) => client.disposeDecoder());
    };
  }, []);

  const handleOutcome = useCallback(
    async (outcome: DecodeOutcome, token: number): Promise<boolean> => {
      if (!sessionRef.current.isCurrent(token)) return true;
      if (outcome.status === "none") return false;

      if (outcome.status === "rejected") {
        if (!sessionRef.current.isCurrent(token)) return true;
        setScanError(outcome.message);
        setScanDiagnostic(outcome.diagnostic);
        stop();
        return true;
      }
      if (outcome.status === "malformed") {
        if (!sessionRef.current.isCurrent(token)) return true;
        setScanError(outcome.message);
        setScanDiagnostic(outcome.diagnostic);
        return false;
      }

      const accepted = await onParsedRef.current(
        outcome.parsed,
        outcome.diagnostic,
      );
      if (!sessionRef.current.isCurrent(token)) return true;
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
    setIsReadingPhoto(false);
    setScanError(null);
    setScanDiagnostic(null);
    setIsScanning(true);
    const token = sessionRef.current.begin();

    try {
      const clientPromise = loadDecodeClient();
      const nativePromise = createNativeQrDetector();
      const streamPromise = sessionRef.current.acquireFirstAvailable(
        token,
        (c) => navigator.mediaDevices.getUserMedia(c),
        [
          {
            video: {
              facingMode: { ideal: "environment" },
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
      const [client, stream, nativeDetector] = await Promise.all([
        clientPromise,
        streamPromise,
        nativePromise,
      ]);
      if (!sessionRef.current.isCurrent(token)) return;
      client.warmUpDecoder();
      let detector: BarcodeDetectorInstance | null = nativeDetector;

      if (!stream || !sessionRef.current.isCurrent(token)) {
        if (!sessionRef.current.isCurrent(token)) return;
        setScanError(`Camera unavailable or permission denied. ${MANUAL_HINT}`);
        setIsScanning(false);
        return;
      }

      await applyBestEffortCameraConstraints(stream);
      if (!sessionRef.current.isCurrent(token)) return;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      if (!sessionRef.current.isCurrent(token)) return;

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      let frameTick = 0;
      let lastFrameAt = 0;
      let busy = false;
      let consecutiveDecodeErrors = 0;

      function video(): HTMLVideoElement | null {
        return videoRef.current;
      }

      const probeImage = (probe: Probe): ImageData | null => {
        if (!ctx || !video()) return null;
        const v = video()!;
        const surface = probeSurface(v.videoWidth, v.videoHeight, probe);
        if (!surface) return null;
        const { sx, sy, cw, ch, dw, dh } = surface;

        canvas.width = dw;
        canvas.height = dh;
        ctx.imageSmoothingEnabled = dw < cw;
        ctx.drawImage(v, sx, sy, cw, ch, 0, 0, dw, dh);
        return ctx.getImageData(0, 0, dw, dh);
      };

      const processFrame = async () => {
        if (!sessionRef.current.isCurrent(token) || !video()) return;

        const now = performance.now();
        if (!busy && now - lastFrameAt >= SCAN_FRAME_INTERVAL_MS) {
          lastFrameAt = now;
          busy = true;
          try {
            const v = video()!;
            if (v.readyState >= 2 && v.videoWidth > 0) {
              frameTick += 1;

              const thorough =
                frameTick > ESCALATE_AFTER_FRAMES &&
                frameTick % THOROUGH_EVERY_N_FRAMES === 0;

              const image =
                probeImage(
                  AADHAAR_PROBES[frameTick % AADHAAR_PROBES.length],
                );
              if (image) {
                let nativeText: string | null = null;
                if (detector) {
                  try {
                    const hits = await detector.detect(canvas);
                    if (!sessionRef.current.isCurrent(token)) return;
                    nativeText = hits[0]?.rawValue ?? null;
                  } catch {
                    detector = null;
                  }
                }
                const outcome = await attemptAadhaarDecode({
                  image,
                  nativeText,
                  client,
                  thorough,
                });
                consecutiveDecodeErrors = 0;
                if (!sessionRef.current.isCurrent(token)) return;
                if (await handleOutcome(outcome, token)) return;
              }
            }
          } catch {
            consecutiveDecodeErrors += 1;
            if (consecutiveDecodeErrors >= 3) {
              if (!sessionRef.current.isCurrent(token)) return;
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
      if (!sessionRef.current.isCurrent(token)) return;
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

        let detector = await createNativeQrDetector();
        if (!sessionRef.current.isCurrent(token)) return;

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
        if (!sessionRef.current.isCurrent(token)) return;

        if (detector) {
          try {
            const full = document.createElement("canvas");
            full.width = width;
            full.height = height;
            const fctx = full.getContext("2d");
            if (fctx) {
              fctx.drawImage(source, 0, 0);
              const hits = await detector.detect(full);
              if (!sessionRef.current.isCurrent(token)) return;
              const raw = hits[0]?.rawValue;
              if (raw) {
                const outcome = await attemptAadhaarDecode({
                  nativeText: raw,
                  client,
                });
                if (!sessionRef.current.isCurrent(token)) return;
                if (await handleOutcome(outcome, token)) {
                  setIsReadingPhoto(false);
                  return;
                }
              }
            }
          } catch {
            detector = null;
          }
        }

        for (const probe of AADHAAR_PROBES) {
          if (!sessionRef.current.isCurrent(token)) return;
          const surface = probeSurface(width, height, probe);
          if (!surface) continue;
          const { sx, sy, cw, ch, dw, dh } = surface;
          canvas.width = dw;
          canvas.height = dh;
          ctx.imageSmoothingEnabled = dw < cw;
          ctx.drawImage(source, sx, sy, cw, ch, 0, 0, dw, dh);

          let nativeText: string | null = null;
          if (detector) {
            try {
              const hits = await detector.detect(canvas);
              if (!sessionRef.current.isCurrent(token)) return;
              nativeText = hits[0]?.rawValue ?? null;
            } catch {
              detector = null;
            }
          }

          const outcome = await attemptAadhaarDecode({
            image: ctx.getImageData(0, 0, dw, dh),
            nativeText,
            client,
            thorough: true,
          });
          if (!sessionRef.current.isCurrent(token)) return;
          if (outcome.status !== "none") {
            setIsReadingPhoto(false);
            await handleOutcome(outcome, token);
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
      const token = sessionRef.current.begin();
      setScanError(null);
      setScanDiagnostic(null);
      setIsReadingUsb(true);
      try {
        const client = await loadDecodeClient();
        if (!sessionRef.current.isCurrent(token)) return;
        const outcome = await attemptAadhaarDecode({
          nativeText: payload,
          client,
        });
        if (!sessionRef.current.isCurrent(token)) return;
        await handleOutcome(outcome, token);
      } catch {
        if (!sessionRef.current.isCurrent(token)) return;
        setScanError("USB scanner payload could not be read. Scan the card again.");
      } finally {
        if (sessionRef.current.isCurrent(token)) setIsReadingUsb(false);
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
