"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  parsePatientIdFromQr,
  parseRegistrationNumber,
} from "@/lib/qr";
import { Button, ErrorBox, Input } from "@/components/ui";
import { Toast } from "@/components/toast";

export type DoctorOption = {
  id: string;
  full_name: string | null;
};

type LookupRow = {
  id: string;
  reg_no: number;
  full_name: string;
  queue_status: string;
  phone: string | null;
  doctor_id: string | null;
  doctor_name: string | null;
};

type AssignRow = {
  id: string;
  reg_no: number;
  full_name: string;
  queue_status: string;
  doctor_id: string | null;
  doctor_name: string | null;
  already_seen: boolean;
  error_code: string | null;
};

interface DetectedBarcode {
  rawValue: string;
}

interface BarcodeDetectorInstance {
  detect: (
    image: HTMLVideoElement | HTMLCanvasElement | ImageBitmap,
  ) => Promise<DetectedBarcode[]>;
}

type BarcodeDetectorConstructor = new (options?: {
  formats: string[];
}) => BarcodeDetectorInstance;

function getBarcodeDetectorClass(): BarcodeDetectorConstructor | null {
  if (typeof window !== "undefined" && "BarcodeDetector" in window) {
    return (window as unknown as Record<string, unknown>)
      .BarcodeDetector as BarcodeDetectorConstructor;
  }
  return null;
}

type Html5QrcodeInstance = {
  stop: () => Promise<void>;
  clear: () => void;
};

let html5QrcodePromise: Promise<typeof import("html5-qrcode")> | null = null;
function getHtml5QrcodeModule() {
  if (!html5QrcodePromise) {
    html5QrcodePromise = import("html5-qrcode");
  }
  return html5QrcodePromise;
}

export function QrScanner({
  mode = "volunteer",
  doctors = [],
  disabledReason,
}: {
  /** doctor = auto self-assign on waiting; volunteer/admin = pick doctor */
  mode?: "volunteer" | "doctor" | "admin";
  doctors?: DoctorOption[];
  disabledReason?: string;
}) {
  const router = useRouter();
  const uid = useId().replace(/:/g, "");
  const regionId = `qr-reader-${uid}`;
  const [error, setError] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [manual, setManual] = useState("");
  const [looking, setLooking] = useState(false);
  const [lookup, setLookup] = useState<LookupRow | null>(null);
  const [assigned, setAssigned] = useState<AssignRow | null>(null);
  const [doctorId, setDoctorId] = useState("");
  const [assigning, setAssigning] = useState(false);
  const [useNative, setUseNative] = useState(false);

  const handledRef = useRef(false);
  const autoScanDone = useRef(false);
  const badScanAt = useRef(0);
  const isMounted = useRef(true);
  const scannerGeneration = useRef(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const html5QrcodeRef = useRef<Html5QrcodeInstance | null>(null);
  const scannerRef = useRef<{
    stop: () => Promise<void>;
    clear: () => void;
  } | null>(null);

  const stopScanner = useCallback(async () => {
    scannerGeneration.current += 1;

    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }

    if (streamRef.current) {
      try {
        streamRef.current.getTracks().forEach((track) => track.stop());
      } catch {
        /* ignore */
      }
      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    const html5Scanner = html5QrcodeRef.current;
    html5QrcodeRef.current = null;
    if (html5Scanner) {
      try {
        await html5Scanner.stop();
      } catch {
        /* ignore */
      }
      try {
        html5Scanner.clear();
      } catch {
        /* ignore */
      }
    }

    const legacyScanner = scannerRef.current;
    scannerRef.current = null;
    if (legacyScanner) {
      try {
        await legacyScanner.stop();
      } catch {
        /* ignore */
      }
      try {
        legacyScanner.clear();
      } catch {
        /* ignore */
      }
    }

    setActive(false);
    setStarting(false);
    setUseNative(false);
  }, []);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
      void stopScanner();
    };
  }, [stopScanner]);

  const assignDoctor = useCallback(
    async (opts: { id?: string; regNo?: number }, chosenDoctorId: string | null) => {
      setAssigning(true);
      setError(null);
      const supabase = createClient();
      const { data, error: err } = await supabase.rpc("assign_patient_doctor", {
        p_patient_id: opts.id ?? null,
        p_reg_no: opts.regNo ?? null,
        p_doctor_id: chosenDoctorId,
      });
      setAssigning(false);

      if (err) {
        handledRef.current = false;
        setError(err.message);
        return null;
      }

      const row = (Array.isArray(data) ? data[0] : data) as AssignRow | null;
      if (!row) {
        handledRef.current = false;
        setError("Could not assign doctor.");
        return null;
      }

      if (row.error_code === "already_seen" || row.already_seen) {
        setError(
          row.doctor_name
            ? `Already seen by ${row.doctor_name}`
            : "Already seen"
        );
        setAssigned(row);
        setLookup(null);
        handledRef.current = true;
        await stopScanner();
        router.refresh();
        return row;
      }

      if (row.error_code === "doctor_required") {
        setError("Select which doctor is seeing this patient.");
        return row;
      }

      try {
        if (typeof window !== "undefined" && "vibrate" in navigator) {
          navigator.vibrate(80);
        }
      } catch {
        /* ignore */
      }
      setAssigned(row);
      setLookup(null);
      setToastMsg(`Patient #${row.reg_no} assigned/seen successfully`);
      handledRef.current = true;
      await stopScanner();
      router.refresh();
      return row;
    },
    [router, stopScanner],
  );

  const resolvePatient = useCallback(
    async (opts: { id?: string; regNo?: number }) => {
      setError(null);
      setLookup(null);
      setAssigned(null);

      if (mode === "doctor") {
        const row = await assignDoctor(opts, null);
        return row;
      }

      const supabase = createClient();
      const { data, error: err } = await supabase.rpc("lookup_patient_scan", {
        p_patient_id: opts.id ?? null,
        p_reg_no: opts.regNo ?? null,
      });

      if (err) {
        handledRef.current = false;
        setError(err.message);
        return null;
      }

      const row = (Array.isArray(data) ? data[0] : data) as LookupRow | null;
      if (!row) {
        handledRef.current = false;
        setError("Patient not found.");
        return null;
      }

      await stopScanner();

      try {
        if (typeof window !== "undefined" && "vibrate" in navigator) {
          navigator.vibrate(40);
        }
      } catch {
        /* ignore */
      }

      if (row.queue_status === "seen") {
        setLookup(row);
        handledRef.current = true;
        return row;
      }

      // Volunteer/admin: registered → offer print (queue) or assign doctor
      setLookup(row);
      handledRef.current = true;
      return row;
    },
    [assignDoctor, mode, stopScanner],
  );

  // Deep-link: ?scan=<uuid> or legacy ?checkin=<uuid>
  useEffect(() => {
    if (autoScanDone.current || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const id = params.get("scan") || params.get("checkin");
    if (!id) {
      const err = params.get("error");
      if (err === "not_found" || err === "scan_lookup" || err === "server") {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setError(
          err === "not_found"
            ? "Patient not found for that QR."
            : "Could not look up that QR. Try again or use reg number.",
        );
      }
      return;
    }
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      )
    ) {
      return;
    }
    autoScanDone.current = true;
    const timer = window.setTimeout(() => {
      void resolvePatient({ id }).then(() => {
        const path = window.location.pathname;
        router.replace(path, { scroll: false });
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [resolvePatient, router]);

  async function start() {
    if (starting || active) return;
    const generation = ++scannerGeneration.current;
    setError(null);
    setLookup(null);
    setAssigned(null);
    handledRef.current = false;
    badScanAt.current = 0;
    setStarting(true);
    setActive(true);

    const BarcodeDetectorClass = getBarcodeDetectorClass();

    if (BarcodeDetectorClass) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });

        if (!isMounted.current || generation !== scannerGeneration.current) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        const detector = new BarcodeDetectorClass({
          formats: ["qr_code"],
        });
        streamRef.current = stream;
        setUseNative(true);

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }

        const processFrame = async () => {
          if (
            generation !== scannerGeneration.current ||
            !isMounted.current ||
            !videoRef.current
          ) {
            return;
          }

          const video = videoRef.current;
          if (video.readyState >= 2 && !handledRef.current) {
            try {
              const barcodes = await detector.detect(video);
              if (barcodes && barcodes.length > 0 && !handledRef.current) {
                for (const barcode of barcodes) {
                  if (barcode.rawValue) {
                    const id = parsePatientIdFromQr(barcode.rawValue);
                    if (id) {
                      handledRef.current = true;
                      void resolvePatient({ id });
                      return;
                    }
                    const now = Date.now();
                    if (now - badScanAt.current > 2500) {
                      badScanAt.current = now;
                      setError(
                        "That QR is not a patient staff-scan code. Use the paper form or reg no.",
                      );
                    }
                  }
                }
              }
            } catch {
              /* ignore frame error */
            }
          }

          if (
            generation === scannerGeneration.current &&
            isMounted.current &&
            !handledRef.current
          ) {
            animFrameRef.current = requestAnimationFrame(processFrame);
          }
        };

        animFrameRef.current = requestAnimationFrame(processFrame);
        setStarting(false);
        return;
      } catch {
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
        }
        setUseNative(false);
      }
    }

    try {
      const { Html5Qrcode } = await getHtml5QrcodeModule();
      if (!isMounted.current || generation !== scannerGeneration.current) return;
      const scanner = new Html5Qrcode(regionId, { verbose: false });
      html5QrcodeRef.current = scanner;
      scannerRef.current = scanner;

      const cameras = await Html5Qrcode.getCameras().catch(() => []);
      if (!isMounted.current || generation !== scannerGeneration.current) {
        try {
          await scanner.stop();
        } catch {
          /* scanner was not started */
        }
        try {
          scanner.clear();
        } catch { /* ignore */ }
        return;
      }
      const back =
        cameras.find((c) => /back|rear|environment/i.test(c.label)) ||
        cameras[cameras.length - 1];
      const cameraId = back?.id || { facingMode: "environment" as const };

      await scanner.start(
        cameraId,
        {
          fps: 25,
          qrbox: (viewfinderWidth: number, viewfinderHeight: number) => {
            const edge = Math.min(viewfinderWidth, viewfinderHeight);
            const size = Math.max(180, Math.floor(edge * 0.72));
            return { width: size, height: size };
          },
          aspectRatio: 1,
          disableFlip: false,
        },
        (decoded) => {
          if (handledRef.current) return;
          const id = parsePatientIdFromQr(decoded);
          if (id) {
            handledRef.current = true;
            void resolvePatient({ id });
            return;
          }
          // Throttle "not a patient QR" so flicker doesn't spam
          const now = Date.now();
          if (now - badScanAt.current > 2500) {
            badScanAt.current = now;
            setError(
              "That QR is not a patient staff-scan code. Use the paper form or reg no.",
            );
          }
        },
        () => undefined,
      );
      if (generation !== scannerGeneration.current) {
        try {
          await scanner.stop();
        } catch {
          /* ignore */
        }
        try {
          scanner.clear();
        } catch {
          /* ignore */
        }
        return;
      }
    } catch (e) {
      if (generation !== scannerGeneration.current || !isMounted.current) return;
      await stopScanner();
      setError(
        e instanceof Error
          ? e.message
          : "Camera failed — allow permission, or use reg number below.",
      );
      setActive(false);
    } finally {
      if (generation === scannerGeneration.current) setStarting(false);
    }
  }

  async function openManual(e: React.FormEvent) {
    e.preventDefault();
    setLooking(true);
    setError(null);
    setLookup(null);
    setAssigned(null);
    handledRef.current = false;
    const raw = manual.trim();

    const cleanedRaw = raw.trim();
    if (cleanedRaw && !/^\d+$/.test(cleanedRaw)) {
      const asId = parsePatientIdFromQr(cleanedRaw);
      if (asId) {
        await resolvePatient({ id: asId });
        setLooking(false);
        return;
      }
      setError("Enter registration number (e.g. 1001) or paste QR link.");
      setLooking(false);
      return;
    }

    const reg = parseRegistrationNumber(raw);
    if (reg === null) {
      setError("Enter registration number (e.g. 1001) or paste QR link.");
      setLooking(false);
      return;
    }

    await resolvePatient({ regNo: reg });
    setLooking(false);
  }

  function resetResult() {
    setLookup(null);
    setAssigned(null);
    setManual("");
    setError(null);
    setDoctorId("");
    handledRef.current = false;
  }

  return (
    <div className="space-y-3">
      {disabledReason ? (
        <div
          className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950"
          role="status"
        >
          {disabledReason}
        </div>
      ) : null}
      <p className="prose-help text-sm text-muted">
        {mode === "doctor" ? (
          <>
            <strong className="text-foreground">Scan</strong> any registered
            patient to mark{" "}
            <strong className="text-foreground">seen</strong> (no print needed).
            Re-scan is blocked.
          </>
        ) : (
          <>
            <strong className="text-foreground">Scan</strong> paper or phone QR
            to assign a doctor (marks seen). Optional: print first to put them
            in the queue. Re-scan is blocked.
          </>
        )}
      </p>

      <div
        id={regionId}
        className={`relative overflow-hidden rounded-2xl border border-border bg-gradient-to-b from-black/[0.04] to-black/[0.02] ${
          active ? "min-h-[280px]" : "min-h-[4.5rem]"
        }`}
        aria-label={active ? "Camera scanner active" : "Camera preview area"}
      >
        <video
          ref={videoRef}
          playsInline
          autoPlay
          muted
          className={
            active && useNative
              ? "h-full w-full object-cover rounded-2xl"
              : "hidden"
          }
        />
        {!active ? (
          <div className="flex h-[4.5rem] items-center justify-center text-sm text-muted">
            Camera preview appears here
          </div>
        ) : null}
      </div>
      <ErrorBox message={error} />

      {assigned ? (
        <div
          className="rounded-xl border border-brand/20 bg-brand-soft px-4 py-3"
          role="status"
          aria-live="polite"
        >
          <p className="text-sm font-semibold text-brand">
            {assigned.already_seen ? "Already seen" : "Seen · doctor assigned"}
          </p>
          <p className="mt-0.5 font-bold text-foreground">
            <span className="tabular">#{assigned.reg_no}</span> ·{" "}
            {assigned.full_name}
          </p>
          <p className="mt-1 text-xs text-brand/80">
            {assigned.doctor_name
              ? `Doctor: ${assigned.doctor_name}`
              : "Doctor recorded"}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href={`/print/${assigned.id}`}
              className="pressable inline-flex min-h-11 items-center justify-center rounded-xl border border-border bg-white px-4 text-sm font-semibold text-brand shadow-sm hover:bg-white/90"
            >
              Reprint form
            </Link>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="w-auto"
              onClick={resetResult}
            >
              Scan next
            </Button>
          </div>
        </div>
      ) : null}

      {lookup && !assigned ? (
        <div className="rounded-xl border border-border bg-card px-4 py-3 shadow-sm">
          <p className="font-bold text-foreground">
            <span className="tabular text-brand">#{lookup.reg_no}</span> ·{" "}
            {lookup.full_name}
          </p>
          {lookup.queue_status === "registered" && mode !== "doctor" ? (
            <>
              <p className="mt-1 text-sm text-muted">
                Registered — print to join the queue, or assign a doctor now
                (no print required).
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link
                  href={`/print/${lookup.id}?auto=1`}
                  className="pressable inline-flex min-h-11 items-center justify-center rounded-xl border border-border bg-white px-4 text-sm font-semibold text-brand shadow-sm hover:bg-brand-soft"
                >
                  Print (join queue)
                </Link>
              </div>
              {doctors.length === 0 ? (
                <p className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
                  No doctors yet. Admin must add doctors first — or a doctor can
                  self-scan.
                </p>
              ) : (
                <div className="mt-3 space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                    Or assign doctor now
                  </p>
                  <div
                    className="grid gap-2 sm:grid-cols-2"
                    role="group"
                    aria-label="Select doctor"
                  >
                    {doctors.map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        aria-pressed={doctorId === d.id}
                        onClick={() => setDoctorId(d.id)}
                        className={`pressable min-h-12 rounded-xl border px-3 py-2 text-left text-sm font-semibold transition-colors ${
                          doctorId === d.id
                            ? "border-brand bg-brand-soft text-brand ring-1 ring-brand/20"
                            : "border-border bg-white text-foreground hover:border-brand/40"
                        }`}
                      >
                        {d.full_name || "Doctor"}
                      </button>
                    ))}
                  </div>
                  <Button
                    type="button"
                    disabled={!doctorId || assigning}
                    loading={assigning}
                    onClick={() => void assignDoctor({ id: lookup.id }, doctorId)}
                  >
                    {assigning ? "Assigning…" : "Assign doctor · mark seen"}
                  </Button>
                </div>
              )}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="mt-2 w-auto"
                onClick={resetResult}
              >
                Cancel
              </Button>
            </>
          ) : null}

          {lookup.queue_status === "seen" ? (
            <>
              <p className="mt-1 text-sm font-semibold text-brand">
                Already seen
                {lookup.doctor_name ? ` by ${lookup.doctor_name}` : ""}
              </p>
              <p className="mt-0.5 text-xs text-muted">
                Multiple scanning is not allowed.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link
                  href={`/print/${lookup.id}`}
                  className="pressable inline-flex min-h-11 items-center justify-center rounded-xl border border-border bg-white px-4 text-sm font-semibold text-brand shadow-sm"
                >
                  Reprint form
                </Link>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="w-auto"
                  onClick={resetResult}
                >
                  Scan next
                </Button>
              </div>
            </>
          ) : null}

          {lookup.queue_status === "waiting" && mode !== "doctor" ? (
            <>
              <p className="mt-1 text-sm text-muted">
                In queue — choose the doctor seeing this patient.
              </p>
              {doctors.length === 0 ? (
                <p className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
                  No doctors yet. Admin must add doctors first.
                </p>
              ) : (
                <div className="mt-3 space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                    Doctor
                  </p>
                  <div
                    className="grid gap-2 sm:grid-cols-2"
                    role="group"
                    aria-label="Select doctor"
                  >
                    {doctors.map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        aria-pressed={doctorId === d.id}
                        onClick={() => setDoctorId(d.id)}
                        className={`pressable min-h-12 rounded-xl border px-3 py-2 text-left text-sm font-semibold transition-colors ${
                          doctorId === d.id
                            ? "border-brand bg-brand-soft text-brand ring-1 ring-brand/20"
                            : "border-border bg-white text-foreground hover:border-brand/40"
                        }`}
                      >
                        {d.full_name || "Doctor"}
                      </button>
                    ))}
                  </div>
                  <Button
                    type="button"
                    disabled={!doctorId || assigning}
                    loading={assigning}
                    onClick={() => void assignDoctor({ id: lookup.id }, doctorId)}
                  >
                    {assigning ? "Assigning…" : "Assign doctor · mark seen"}
                  </Button>
                </div>
              )}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="mt-2 w-auto"
                onClick={resetResult}
              >
                Cancel
              </Button>
            </>
          ) : null}
        </div>
      ) : null}

      {!active ? (
        <Button
          type="button"
          disabled={Boolean(disabledReason)}
          onClick={() => void start()}
        >
          {starting ? "Opening camera…" : "Open camera scanner"}
        </Button>
      ) : (
        <Button
          type="button"
          variant="secondary"
          onClick={() => void stopScanner()}
        >
          Stop camera
        </Button>
      )}

      <form
        onSubmit={(e) => void openManual(e)}
        className="space-y-2 border-t border-border pt-3"
      >
        <p className="text-sm font-medium text-foreground/80">
          Or look up by reg number
        </p>
        <Input
          label="Reg no / QR link"
          inputMode="text"
          placeholder="e.g. 1001 or paste QR link"
          disabled={Boolean(disabledReason)}
          value={manual}
          onChange={(e) => setManual(e.target.value)}
        />
        <Button
          type="submit"
          variant="secondary"
          disabled={looking || Boolean(disabledReason)}
        >
          {looking ? "Looking up…" : "Look up patient"}
        </Button>
      </form>
      {toastMsg ? (
        <Toast message={toastMsg} onClose={() => setToastMsg(null)} />
      ) : null}
    </div>
  );
}

