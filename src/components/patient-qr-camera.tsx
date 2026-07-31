"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { QrCameraSession } from "@/lib/qr-camera-session";
import { decodeScale, MAX_DECODE_EDGE } from "@/lib/qr-decode-geometry";

type Detector = {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
};

type JsQrFn = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
) => { data: string } | null;

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

/**
 * Lightweight patient-QR camera for Clinical Desk.
 * Uses the same session lifecycle + decode edge bound as the desk scanner —
 * never full-resolution main-thread jsQR every frame.
 */
export function PatientQrCamera({ onScan }: { onScan: (raw: string) => void }) {
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const frame = useRef<number | null>(null);
  const sessionRef = useRef(new QrCameraSession());
  const onScanRef = useRef(onScan);

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  function stop() {
    if (frame.current != null) cancelAnimationFrame(frame.current);
    frame.current = null;
    sessionRef.current.invalidate();
    setActive(false);
  }

  useEffect(() => () => stop(), []);

  async function start() {
    setError(null);
    const token = sessionRef.current.begin();
    try {
      const stream = await sessionRef.current.acquireFirstAvailable(
        token,
        (constraints) => navigator.mediaDevices.getUserMedia(constraints),
        [
          {
            video: {
              facingMode: { ideal: "environment" },
              width: { ideal: 1280 },
              height: { ideal: 720 },
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
      if (!stream || !sessionRef.current.isCurrent(token)) {
        stop();
        setError("Camera unavailable. Type the exact registration number.");
        return;
      }
      if (!video.current) {
        stop();
        return;
      }
      video.current.srcObject = stream;
      await video.current.play();
      if (!sessionRef.current.isCurrent(token)) return;
      setActive(true);

      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { willReadFrequently: true });
      let detector: Detector | null = null;
      const Constructor = (
        window as typeof window & {
          BarcodeDetector?: new (options: { formats: string[] }) => Detector;
        }
      ).BarcodeDetector;
      if (Constructor) detector = new Constructor({ formats: ["qr_code"] });

      let last = 0;
      const scan = async (time: number) => {
        if (!sessionRef.current.isCurrent(token)) return;
        if (!video.current || !context || !sessionRef.current.mediaStream) return;
        if (time - last >= 140 && video.current.videoWidth > 0) {
          last = time;
          const vw = video.current.videoWidth;
          const vh = video.current.videoHeight;
          const scale = decodeScale(vw, vh, MAX_DECODE_EDGE);
          const dw = Math.max(1, Math.floor(vw * scale));
          const dh = Math.max(1, Math.floor(vh * scale));
          if (canvas.width !== dw || canvas.height !== dh) {
            canvas.width = dw;
            canvas.height = dh;
          }
          context.drawImage(video.current, 0, 0, dw, dh);

          let raw: string | null = null;
          if (detector) {
            raw =
              (await detector.detect(canvas).catch(() => []))[0]?.rawValue ??
              null;
          }
          if (!raw) {
            const image = context.getImageData(0, 0, dw, dh);
            const jsQR = await loadJsQr();
            if (!sessionRef.current.isCurrent(token)) return;
            raw = jsQR(image.data, image.width, image.height)?.data ?? null;
          }
          if (raw && sessionRef.current.isCurrent(token)) {
            stop();
            onScanRef.current(raw);
            return;
          }
        }
        frame.current = requestAnimationFrame(scan);
      };
      frame.current = requestAnimationFrame(scan);
    } catch {
      setError("Camera unavailable. Type the exact registration number.");
      stop();
    }
  }

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-xl border border-border bg-black">
        <video
          ref={video}
          className="aspect-video w-full object-cover"
          muted
          playsInline
          aria-label="Patient QR camera"
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {!active ? (
          <Button type="button" onClick={() => void start()}>
            Open camera
          </Button>
        ) : (
          <Button type="button" variant="secondary" onClick={stop}>
            Stop camera
          </Button>
        )}
      </div>
    </div>
  );
}
