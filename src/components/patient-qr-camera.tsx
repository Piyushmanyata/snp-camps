"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";

type Detector = {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
};

export function PatientQrCamera({ onScan }: { onScan: (raw: string) => void }) {
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const frame = useRef<number | null>(null);

  function stop() {
    if (frame.current != null) cancelAnimationFrame(frame.current);
    frame.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    setActive(false);
  }

  useEffect(() => stop, []);

  async function start() {
    setError(null);
    try {
      const next = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      stream.current = next;
      if (!video.current) return stop();
      video.current.srcObject = next;
      await video.current.play();
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
        if (!video.current || !context || !stream.current) return;
        if (time - last >= 140 && video.current.videoWidth > 0) {
          last = time;
          canvas.width = video.current.videoWidth;
          canvas.height = video.current.videoHeight;
          context.drawImage(video.current, 0, 0);
          let raw = detector
            ? (await detector.detect(canvas).catch(() => []))[0]?.rawValue
            : null;
          if (!raw) {
            const image = context.getImageData(0, 0, canvas.width, canvas.height);
            const jsQR = (await import("jsqr")).default;
            raw = jsQR(image.data, image.width, image.height)?.data ?? null;
          }
          if (raw) {
            stop();
            onScan(raw);
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
      <video
        ref={video}
        muted
        playsInline
        className={`${active ? "block" : "hidden"} aspect-video w-full rounded-xl bg-black object-cover`}
      />
      {active ? (
        <Button type="button" variant="secondary" onClick={stop}>Close camera</Button>
      ) : (
        <Button type="button" variant="secondary" onClick={() => void start()}>Open Patient QR camera</Button>
      )}
      {error ? <p role="alert" className="text-sm font-semibold text-danger">{error}</p> : null}
    </div>
  );
}
