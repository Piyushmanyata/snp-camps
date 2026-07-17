"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { parsePatientIdFromQr } from "@/lib/qr";
import { Button, ErrorBox, Input } from "@/components/ui";

type Joined = {
  id: string;
  reg_no: number;
  full_name: string;
  queue_status: string;
  already_in_queue: boolean;
};

export function QrScanner() {
  const router = useRouter();
  const regionId = "qr-reader";
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const [manual, setManual] = useState("");
  const [looking, setLooking] = useState(false);
  const [joined, setJoined] = useState<Joined | null>(null);
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

  async function checkIn(opts: { id?: string; regNo?: number }) {
    setError(null);
    setJoined(null);

    const supabase = createClient();
    const { data, error: err } = await supabase.rpc("join_queue", {
      p_patient_id: opts.id ?? null,
      p_reg_no: opts.regNo ?? null,
    });

    if (err) {
      handledRef.current = false;
      setError(err.message);
      return;
    }

    const row = (Array.isArray(data) ? data[0] : data) as Joined | null;
    if (!row) {
      handledRef.current = false;
      setError("Could not add to queue.");
      return;
    }

    setJoined(row);
    handledRef.current = true;
    try {
      await scannerRef.current?.stop();
      scannerRef.current?.clear();
    } catch {
      /* ignore */
    }
    scannerRef.current = null;
    setActive(false);
    router.refresh();
  }

  async function start() {
    setError(null);
    setJoined(null);
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
          if (handledRef.current) return;
          const id = parsePatientIdFromQr(decoded);
          if (id) {
            handledRef.current = true;
            void checkIn({ id });
          }
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
    setJoined(null);
    handledRef.current = false;
    const raw = manual.trim();

    const asId = parsePatientIdFromQr(raw);
    if (asId) {
      await checkIn({ id: asId });
      setLooking(false);
      return;
    }

    const reg = Number(raw.replace(/[^\d]/g, ""));
    if (!reg || Number.isNaN(reg)) {
      setError("Enter registration number (e.g. 1001) or paste QR link.");
      setLooking(false);
      return;
    }

    await checkIn({ regNo: reg });
    setLooking(false);
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Scan QR or enter reg no to <strong>add the patient to the queue</strong>
        . They are not queued at registration.
      </p>

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

      {joined ? (
        <div className="rounded-xl border border-brand/20 bg-brand-soft px-4 py-3">
          <p className="text-sm font-semibold text-brand">
            {joined.queue_status === "seen"
              ? "Already seen"
              : joined.already_in_queue
                ? "Already in queue"
                : "Added to queue"}
          </p>
          <p className="mt-0.5 font-bold text-foreground">
            #{joined.reg_no} · {joined.full_name}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {joined.queue_status !== "seen" ? (
              <Link
                href={`/print/${joined.id}`}
                className="inline-flex min-h-10 items-center justify-center rounded-xl bg-brand px-4 text-sm font-semibold text-white"
              >
                Print prescription
              </Link>
            ) : (
              <Link
                href={`/print/${joined.id}`}
                className="inline-flex min-h-10 items-center justify-center rounded-xl border border-border bg-white px-4 text-sm font-semibold text-brand"
              >
                Open print again
              </Link>
            )}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="w-auto"
              onClick={() => {
                setJoined(null);
                setManual("");
                handledRef.current = false;
              }}
            >
              Check in next
            </Button>
          </div>
        </div>
      ) : null}

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
          Or check in by reg number
        </p>
        <Input
          label="Reg no / QR link"
          inputMode="numeric"
          placeholder="e.g. 1001"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
        />
        <Button type="submit" variant="secondary" disabled={looking}>
          {looking ? "Checking in…" : "Add to queue"}
        </Button>
      </form>
    </div>
  );
}
