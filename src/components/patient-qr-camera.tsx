"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import {
  canUseNativeQrDetector,
  decodeQrFromImageData,
  getBarcodeDetectorConstructor,
  type BarcodeDetectorInstance,
  type JsQrFn,
} from "@/lib/qr-detector";
import { QrCameraSession } from "@/lib/qr-camera-session";
import { decodeScale, MAX_DECODE_EDGE } from "@/lib/qr-decode-geometry";

let jsQrPromise: Promise<JsQrFn> | null = null;
function loadJsQr(): Promise<JsQrFn> {
  if (!jsQrPromise) {
    jsQrPromise = import("jsqr").then((module) => {
      return (module as { default?: JsQrFn }).default ?? (module as unknown as JsQrFn);
    });
  }
  return jsQrPromise;
}

/** Lightweight Clinical Desk QR camera with owned, generation-guarded work. */
type PatientQrCameraProps = {
  onScan: (raw: string) => void;
  disabled?: boolean;
};

export function PatientQrCamera(props: PatientQrCameraProps) {
  return (
    <PatientQrCameraRuntime
      key={props.disabled ? "disabled" : "enabled"}
      {...props}
    />
  );
}

function PatientQrCameraRuntime({
  onScan,
  disabled = false,
}: PatientQrCameraProps) {
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
    if (video.current) video.current.srcObject = null;
    setActive(false);
  }

  useEffect(() => () => stop(), []);

  async function start() {
    if (disabled) return;
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
          { video: { facingMode: { ideal: "environment" } }, audio: false },
          { video: true, audio: false },
        ],
      );
      if (!sessionRef.current.isCurrent(token)) return;
      if (!stream) {
        sessionRef.current.invalidate();
        setActive(false);
        setError("Camera unavailable. Type the exact registration number.");
        return;
      }
      if (!video.current) {
        sessionRef.current.invalidate();
        return;
      }

      video.current.srcObject = stream;
      await video.current.play();
      if (!sessionRef.current.isCurrent(token)) {
        if (video.current.srcObject === stream) video.current.srcObject = null;
        return;
      }
      setActive(true);

      let detector: BarcodeDetectorInstance | null = null;
      if (await canUseNativeQrDetector()) {
        if (!sessionRef.current.isCurrent(token)) return;
        const Constructor = getBarcodeDetectorConstructor();
        try {
          detector = Constructor ? new Constructor({ formats: ["qr_code"] }) : null;
        } catch {
          detector = null;
        }
      }
      if (!sessionRef.current.isCurrent(token)) return;

      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { willReadFrequently: true });
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
            try {
              const detected = await detector.detect(canvas);
              if (!sessionRef.current.isCurrent(token)) return;
              raw = detected[0]?.rawValue ?? null;
            } catch {
              if (!sessionRef.current.isCurrent(token)) return;
              raw = null;
            }
          }
          if (!raw) {
            const image = context.getImageData(0, 0, dw, dh);
            let jsQR: JsQrFn;
            try {
              jsQR = await loadJsQr();
            } catch {
              if (!sessionRef.current.isCurrent(token)) return;
              sessionRef.current.invalidate();
              setActive(false);
              setError("QR camera unavailable. Type the exact registration number.");
              return;
            }
            if (!sessionRef.current.isCurrent(token)) return;
            raw = decodeQrFromImageData(jsQR, image);
          }
          if (raw && sessionRef.current.isCurrent(token)) {
            stop();
            onScanRef.current(raw);
            return;
          }
        }
        if (sessionRef.current.isCurrent(token)) {
          frame.current = requestAnimationFrame(scan);
        }
      };
      frame.current = requestAnimationFrame(scan);
    } catch {
      if (!sessionRef.current.isCurrent(token)) return;
      sessionRef.current.invalidate();
      setActive(false);
      setError("Camera unavailable. Type the exact registration number.");
    }
  }

  const cameraActive = active && !disabled;
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
        {!cameraActive ? (
          <Button type="button" disabled={disabled} onClick={() => void start()}>
            Open camera
          </Button>
        ) : (
          <Button type="button" variant="secondary" disabled={disabled} onClick={stop}>
            Stop camera
          </Button>
        )}
      </div>
    </div>
  );
}
