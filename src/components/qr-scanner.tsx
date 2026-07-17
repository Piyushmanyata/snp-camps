"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { parsePatientIdFromQr } from "@/lib/qr";
import { Button, ErrorBox, Input } from "@/components/ui";

export function QrScanner() {
  const router = useRouter();
  const regionId = "qr-reader";
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const [manual, setManual] = useState("");
  const [looking, setLooking] = useState(false);
  const handledRef = useRef(false);
  const scannerRef = useRef<{
    stop: () => Promise<void>;
    clear: () => void;
  } | null>(null);

  useEffect(() => {
    return () => {
      const s = scannerRef.current;
      if (s) {
        s.stop().catch(() => undefined);
        try {
          s.clear();
        } catch {
          /* ignore */
        }
      }
    };
  }, []);

  function goToPatient(id: string) {
    if (handledRef.current) return;
    handledRef.current = true;
    scannerRef.current?.stop().catch(() => undefined);
    router.push(`/print/${id}`);
  }

  async function start() {
    setError(null);
    handledRef.current = false;
    setActive(true);
    await new Promise((r) => setTimeout(r, 50));
    try {
      const { Html5Qrcode } = await import("html5-qrcode");
      if (scannerRef.current) {
        try {
          await scannerRef.current.stop();
          scannerRef.current.clear();
        } catch {
          /* ignore */
        }
      }
      const scanner = new Html5Qrcode(regionId, { verbose: false });
      scannerRef.current = scanner;

      const cameras = await Html5Qrcode.getCameras().catch(() => []);
      const back =
        cameras.find((c) => /back|rear|environment/i.test(c.label)) ||
        cameras[cameras.length - 1];
      const cameraId = back?.id || { facingMode: "environment" as const };

      await scanner.start(
        cameraId,
        {
          fps: 10,
          qrbox: { width: 250, height: 250 },
          aspectRatio: 1,
        },
        (decoded) => {
          const id = parsePatientIdFromQr(decoded);
          if (id) goToPatient(id);
        },
        () => undefined,
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Camera failed — allow permission, or use reg number below.",
      );
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
    scannerRef.current = null;
    setActive(false);
  }

  async function openManual(e: React.FormEvent) {
    e.preventDefault();
    setLooking(true);
    setError(null);
    const raw = manual.trim();

    const asId = parsePatientIdFromQr(raw);
    if (asId) {
      goToPatient(asId);
      setLooking(false);
      return;
    }

    const reg = Number(raw.replace(/[^\d]/g, ""));
    if (!reg || Number.isNaN(reg)) {
      setError("Enter registration number (e.g. 1001) or paste QR link.");
      setLooking(false);
      return;
    }

    const supabase = createClient();
    const { data, error: err } = await supabase
      .from("patients")
      .select("id")
      .eq("reg_no", reg)
      .maybeSingle();

    if (err) {
      setError(err.message);
      setLooking(false);
      return;
    }
    if (!data) {
      setError(`No patient with reg no ${reg}`);
      setLooking(false);
      return;
    }
    goToPatient(data.id);
    setLooking(false);
  }

  return (
    <div className="space-y-3">
      <div
        id={regionId}
        className={`overflow-hidden rounded-2xl border border-border bg-gradient-to-b from-black/[0.04] to-black/[0.02] ${
          active ? "min-h-[280px]" : "min-h-[4.5rem]"
        }`}
      >
        {!active ? (
          <div className="flex h-[4.5rem] items-center justify-center text-sm text-muted">
            Camera preview appears here
          </div>
        ) : null}
      </div>
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

      <form
        onSubmit={openManual}
        className="space-y-2 border-t border-border pt-3"
      >
        <p className="text-sm font-medium text-foreground/80">
          Or open by reg number
        </p>
        <Input
          label="Reg no / QR link"
          inputMode="numeric"
          placeholder="e.g. 1001"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
        />
        <Button type="submit" variant="secondary" disabled={looking}>
          {looking ? "Looking…" : "Open print"}
        </Button>
      </form>
    </div>
  );
}
