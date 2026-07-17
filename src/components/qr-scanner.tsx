"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ErrorBox } from "@/components/ui";

export function QrScanner() {
  const router = useRouter();
  const regionId = "qr-reader";
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const scannerRef = useRef<{
    stop: () => Promise<void>;
    clear: () => void;
  } | null>(null);

  useEffect(() => {
    return () => {
      scannerRef.current?.stop().catch(() => undefined);
      scannerRef.current?.clear();
    };
  }, []);

  async function start() {
    setError(null);
    setActive(true);
    try {
      const { Html5Qrcode } = await import("html5-qrcode");
      const scanner = new Html5Qrcode(regionId);
      scannerRef.current = scanner;
      await scanner.start(
        { facingMode: "environment" },
        { fps: 8, qrbox: { width: 240, height: 240 } },
        (decoded) => {
          const match = decoded.match(/\/print\/([0-9a-f-]{36})/i);
          const id = match?.[1] || (decoded.match(/^[0-9a-f-]{36}$/i) ? decoded : null);
          if (id) {
            scanner.stop().catch(() => undefined);
            router.push(`/print/${id}`);
          }
        },
        () => undefined,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Camera failed");
      setActive(false);
    }
  }

  async function stop() {
    try {
      await scannerRef.current?.stop();
      scannerRef.current?.clear();
    } catch {
      /* ignore */
    }
    setActive(false);
  }

  return (
    <div className="space-y-3">
      <div
        id={regionId}
        className="overflow-hidden rounded-2xl border border-border bg-black/5"
      />
      <ErrorBox message={error} />
      {!active ? (
        <Button type="button" onClick={start}>
          Open camera scanner
        </Button>
      ) : (
        <Button type="button" variant="secondary" onClick={stop}>
          Stop camera
        </Button>
      )}
    </div>
  );
}
