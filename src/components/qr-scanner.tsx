"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  parsePatientIdFromQr,
  parseRegistrationNumber,
} from "@/lib/qr";
import {
  canUseNativeQrDetector,
  decodeQrFromImageData,
  getBarcodeDetectorConstructor,
  type BarcodeDetectorInstance,
} from "@/lib/qr-detector";
import { isSuccessfulAssignment } from "@/lib/queue-assignment";
import { Button, ErrorBox, Input, WarningBox } from "@/components/ui";
import { Toast } from "@/components/toast";
import { mapDbError } from "@/lib/public-error";
import type { DoctorOption } from "@/lib/types";

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

type JsQrFn = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
) => { data: string } | null;

const SCANNER_FPS = 10;
const SCANNER_FRAME_INTERVAL_MS = 1000 / SCANNER_FPS;
const SCANNER_VIDEO_WIDTH = 1280;
const SCANNER_VIDEO_HEIGHT = 720;

function ensureCanvasSize(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): void {
  if (canvas.width === width && canvas.height === height) return;
  canvas.width = width;
  canvas.height = height;
}

/** Dynamic import only after native capability fails (#49). */
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
  const reviewHeadingId = `qr-review-heading-${uid}`;
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

  const handledRef = useRef(false);
  const autoScanDone = useRef(false);
  const badScanAt = useRef(0);
  const isMounted = useRef(true);
  const scannerGeneration = useRef(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const reviewRef = useRef<HTMLDivElement | null>(null);
  const assigningRef = useRef(false);

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

    setActive(false);
    setStarting(false);
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
      if (assigningRef.current) return null;
      assigningRef.current = true;
      setAssigning(true);
      setError(null);
      try {
        const supabase = createClient();
        const { data, error: err } = await supabase.rpc("assign_patient_doctor", {
          p_patient_id: opts.id ?? null,
          p_reg_no: opts.regNo ?? null,
          p_doctor_id: chosenDoctorId,
        });

        if (err) {
          handledRef.current = false;
          setError(
            mapDbError(err, {
              context: "qr-scanner.assign",
              fallback: "Could not assign doctor. Try again.",
            }),
          );
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
              : "Already seen",
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

        if (!isSuccessfulAssignment(row)) {
          handledRef.current = false;
          setError(
            row.error_code
              ? "Could not mark this patient as seen. Try again or ask an administrator."
              : "Doctor assignment did not complete. No success was recorded.",
          );
          return null;
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
      } catch {
        handledRef.current = false;
        setError(
          "Could not assign this patient. Check the connection and try again.",
        );
        return null;
      } finally {
        assigningRef.current = false;
        setAssigning(false);
      }
    },
    [router, stopScanner],
  );

  const resolvePatient = useCallback(
    async (opts: { id?: string; regNo?: number }) => {
      if (assigningRef.current) return null;
      setError(null);
      setLookup(null);
      setAssigned(null);

      try {
        const supabase = createClient();
        const { data, error: err } = await supabase.rpc("lookup_patient_scan", {
          p_patient_id: opts.id ?? null,
          p_reg_no: opts.regNo ?? null,
        });

        if (err) {
          handledRef.current = false;
          setError(
            mapDbError(err, {
              context: "qr-scanner.lookup",
              fallback: "Could not look up this patient. Try again.",
            }),
          );
          return null;
        }

        let row = (Array.isArray(data) ? data[0] : data) as LookupRow | null;
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

        // Desk: scanning a pre-registered patient checks them into the queue (#46).
        if (
          row.queue_status === "registered" &&
          mode !== "doctor"
        ) {
          const { data: checkData, error: checkErr } = await supabase.rpc(
            "check_in_patient",
            {
              p_patient_id: row.id,
              p_reg_no: null,
            },
          );
          if (checkErr) {
            handledRef.current = false;
            setError(
              mapDbError(checkErr, {
                context: "qr-scanner.check-in",
                fallback: "Could not check in this patient. Try again.",
              }),
            );
            setLookup(row);
            return row;
          }
          const checked = (
            Array.isArray(checkData) ? checkData[0] : checkData
          ) as {
            queue_status?: string;
            already_waiting?: boolean;
            error_code?: string | null;
            doctor_name?: string | null;
          } | null;
          if (checked?.error_code === "already_seen") {
            setError(
              checked.doctor_name
                ? `Already seen by ${checked.doctor_name}`
                : "Already seen",
            );
            setLookup({
              ...row,
              queue_status: "seen",
              doctor_name: checked.doctor_name ?? row.doctor_name,
            });
            handledRef.current = true;
            return row;
          }
          if (checked?.queue_status === "waiting") {
            row = { ...row, queue_status: "waiting" };
            setToastMsg(
              checked.already_waiting
                ? `#${row.reg_no} already in queue`
                : `#${row.reg_no} checked in`,
            );
            router.refresh();
          }
        }

        setLookup(row);
        handledRef.current = true;
        return row;
      } catch {
        handledRef.current = false;
        setError("Could not look up this patient. Check the connection and try again.");
        return null;
      }
    },
    [mode, router, stopScanner],
  );

  useEffect(() => {
    if (!lookup) return;
    const frame = window.requestAnimationFrame(() => reviewRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [lookup]);

  // Deep-link: ?scan=<uuid> or legacy ?checkin=<uuid>
  useEffect(() => {
    if (autoScanDone.current || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const id = params.get("scan") || params.get("checkin");
    if (!id) {
      const err = params.get("error");
      if (err === "not_found" || err === "scan_lookup" || err === "server") {
        const timer = setTimeout(() => {
          setError(
            err === "not_found"
              ? "Patient not found for that QR."
              : "Could not look up that QR. Try again or use reg number.",
          );
        }, 0);
        return () => clearTimeout(timer);
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
        // Strip ?scan= via History API so the lookup card is not remounted away.
        const next = window.location.pathname;
        window.history.replaceState(null, "", next);
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [resolvePatient]);

  function onDecodedText(decoded: string) {
    if (handledRef.current) return;
    const id = parsePatientIdFromQr(decoded);
    if (id) {
      handledRef.current = true;
      void resolvePatient({ id });
      return;
    }
    const now = Date.now();
    if (now - badScanAt.current > 2500) {
      badScanAt.current = now;
      setError(
        "That QR is not a patient staff-scan code. Type the registration number beside the camera.",
      );
    }
  }

  async function applyBestEffortCameraConstraints(stream: MediaStream) {
    try {
      const track = stream.getVideoTracks()[0];
      const caps = track?.getCapabilities?.() as
        | { focusMode?: string[]; zoom?: { min: number; max: number } }
        | undefined;
      const constraints: Record<string, unknown> = {};
      if (caps?.focusMode?.includes("continuous")) {
        constraints.focusMode = "continuous";
      }
      if (caps?.zoom && caps.zoom.max > caps.zoom.min) {
        constraints.zoom = Math.min(
          caps.zoom.max,
          Math.max(caps.zoom.min, (caps.zoom.min + caps.zoom.max) * 0.35),
        );
      }
      if (Object.keys(constraints).length && track) {
        await track.applyConstraints({
          advanced: [constraints],
        } as unknown as MediaTrackConstraints);
      }
    } catch {
      /* ignore unsupported constraints */
    }
  }

  async function openCameraStream(generation: number): Promise<MediaStream | null> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: SCANNER_VIDEO_WIDTH },
          height: { ideal: SCANNER_VIDEO_HEIGHT },
        },
        audio: false,
      });
      if (!isMounted.current || generation !== scannerGeneration.current) {
        stream.getTracks().forEach((t) => t.stop());
        return null;
      }
      return stream;
    } catch {
      if (generation === scannerGeneration.current && isMounted.current) {
        setError(
          "Camera unavailable or permission denied. Type the registration number beside the camera.",
        );
        setActive(false);
        setStarting(false);
      }
      return null;
    }
  }

  function startDecodeLoop(
    generation: number,
    options: {
      detector?: BarcodeDetectorInstance;
      jsQR?: JsQrFn;
    },
  ) {
    const canvasFull = document.createElement("canvas");
    const canvasHalf = document.createElement("canvas");
    const ctxFull = canvasFull.getContext("2d", { willReadFrequently: true });
    const ctxHalf = canvasHalf.getContext("2d", { willReadFrequently: true });
    let lastFrameTime = 0;
    let scaleTick = 0;
    let consecutiveFrameErrors = 0;

    const tryNative = async (
      source: HTMLVideoElement | HTMLCanvasElement,
    ): Promise<boolean> => {
      if (!options.detector || handledRef.current) return false;
      const barcodes = await options.detector.detect(source);
      if (!barcodes?.length) return false;
      for (const barcode of barcodes) {
        if (!barcode.rawValue) continue;
        onDecodedText(barcode.rawValue);
        if (handledRef.current) return true;
      }
      return false;
    };

    const tryJsQr = (source: HTMLCanvasElement): boolean => {
      if (!options.jsQR || !ctxFull || handledRef.current) return false;
      const imageData = ctxFull.getImageData(
        0,
        0,
        source.width,
        source.height,
      );
      const text = decodeQrFromImageData(options.jsQR, imageData);
      if (!text) return false;
      onDecodedText(text);
      return handledRef.current;
    };

    const processFrame = async () => {
      if (
        generation !== scannerGeneration.current ||
        !isMounted.current ||
        !videoRef.current
      ) {
        return;
      }

      const now = performance.now();
      if (now - lastFrameTime >= SCANNER_FRAME_INTERVAL_MS) {
        lastFrameTime = now;
        const video = videoRef.current;
        if (video.readyState >= 2 && !handledRef.current) {
          try {
            if (options.detector) {
              if (await tryNative(video)) return;
              if (ctxFull && ctxHalf && video.videoWidth > 0) {
                scaleTick += 1;
                if (scaleTick % 2 === 0) {
                  const vw = video.videoWidth;
                  const vh = video.videoHeight;
                  const cw = Math.floor(vw * 0.72);
                  const ch = Math.floor(vh * 0.72);
                  const sx = Math.floor((vw - cw) / 2);
                  const sy = Math.floor((vh - ch) / 2);
                  ensureCanvasSize(canvasFull, cw, ch);
                  ctxFull.drawImage(video, sx, sy, cw, ch, 0, 0, cw, ch);
                  if (await tryNative(canvasFull)) return;
                  ensureCanvasSize(
                    canvasHalf,
                    Math.max(320, Math.floor(cw / 2)),
                    Math.max(240, Math.floor(ch / 2)),
                  );
                  ctxHalf.drawImage(
                    canvasFull,
                    0,
                    0,
                    cw,
                    ch,
                    0,
                    0,
                    canvasHalf.width,
                    canvasHalf.height,
                  );
                  if (await tryNative(canvasHalf)) return;
                }
              }
            } else if (options.jsQR && ctxFull && video.videoWidth > 0) {
              const vw = video.videoWidth;
              const vh = video.videoHeight;
              // Downscale for jsQR CPU cost on weak phones (~half resolution).
              const dw = Math.max(320, Math.floor(vw / 2));
              const dh = Math.max(240, Math.floor(vh / 2));
              ensureCanvasSize(canvasFull, dw, dh);
              ctxFull.drawImage(video, 0, 0, dw, dh);
              if (tryJsQr(canvasFull)) return;
            }
            consecutiveFrameErrors = 0;
          } catch {
            consecutiveFrameErrors += 1;
            if (consecutiveFrameErrors >= 5) {
              await stopScanner();
              if (isMounted.current) {
                setError(
                  "Camera decoding stopped. Type the registration number beside the camera.",
                );
              }
              return;
            }
          }
        }
      }

      if (
        generation === scannerGeneration.current &&
        isMounted.current &&
        !handledRef.current
      ) {
        animFrameRef.current = requestAnimationFrame(() => {
          void processFrame();
        });
      }
    };

    animFrameRef.current = requestAnimationFrame(() => {
      void processFrame();
    });
  }

  async function start() {
    if (starting || active || looking || assigningRef.current) return;
    const generation = ++scannerGeneration.current;
    setError(null);
    setLookup(null);
    setAssigned(null);
    handledRef.current = false;
    badScanAt.current = 0;
    setStarting(true);
    setActive(true);

    try {
      const useNative = await canUseNativeQrDetector();
      if (!isMounted.current || generation !== scannerGeneration.current) return;

      if (useNative) {
        const Ctor = getBarcodeDetectorConstructor();
        if (!Ctor) {
          // formats gate passed but constructor vanished — fall through to jsQR
        } else {
          const stream = await openCameraStream(generation);
          if (!stream) return;
          streamRef.current = stream;
          await applyBestEffortCameraConstraints(stream);
          if (!videoRef.current) {
            throw new Error("Camera preview is unavailable");
          }
          videoRef.current.srcObject = stream;
          videoRef.current.setAttribute("playsinline", "true");
          await videoRef.current.play();
          if (!isMounted.current || generation !== scannerGeneration.current) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          const detector = new Ctor({ formats: ["qr_code"] });
          startDecodeLoop(generation, { detector });
          if (generation === scannerGeneration.current) setStarting(false);
          return;
        }
      }

      // Fallback: jsQR loaded only when native path is unavailable.
      let jsQR: JsQrFn;
      try {
        jsQR = await loadJsQr();
      } catch {
        if (generation === scannerGeneration.current && isMounted.current) {
          await stopScanner();
          setError(
            "QR decoder could not load. Type the registration number beside the camera.",
          );
        }
        return;
      }
      if (!isMounted.current || generation !== scannerGeneration.current) return;

      const stream = await openCameraStream(generation);
      if (!stream) return;
      streamRef.current = stream;
      await applyBestEffortCameraConstraints(stream);
      if (!videoRef.current) {
        throw new Error("Camera preview is unavailable");
      }
      videoRef.current.srcObject = stream;
      videoRef.current.setAttribute("playsinline", "true");
      await videoRef.current.play();
      if (!isMounted.current || generation !== scannerGeneration.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      startDecodeLoop(generation, { jsQR });
    } catch (e) {
      if (generation !== scannerGeneration.current || !isMounted.current) return;
      await stopScanner();
      setError(
        e instanceof Error
          ? e.message
          : "Camera failed. Type the registration number beside the camera.",
      );
      setActive(false);
    } finally {
      if (generation === scannerGeneration.current) setStarting(false);
    }
  }

  async function openManual(e: React.FormEvent) {
    e.preventDefault();
    if (looking || assigningRef.current) return;
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
      setError("Enter registration number (e.g. 1001).");
      setLooking(false);
      return;
    }

    const reg = parseRegistrationNumber(raw);
    if (reg === null) {
      setError("Enter registration number (e.g. 1001).");
      setLooking(false);
      return;
    }

    await resolvePatient({ regNo: reg });
    setLooking(false);
  }

  function resetResult() {
    if (assigningRef.current) return;
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
            <strong className="text-foreground">Scan</strong> to check the
            patient, then confirm before marking them{" "}
            <strong className="text-foreground">seen</strong>. No print is
            needed, and re-scan is blocked.
          </>
        ) : (
          <>
            <strong className="text-foreground">Scan</strong> paper or phone QR:
            pre-registered patients are checked in, then you can assign a
            doctor (marks seen). Re-scan of seen is blocked.
          </>
        )}
      </p>

      <div className="grid gap-3 sm:grid-cols-2 sm:items-stretch">
        <div className="flex min-h-[16rem] flex-col gap-2 rounded-2xl border border-border bg-card p-3">
          <p className="text-sm font-semibold text-foreground">Scan QR</p>
          <div
            className={`relative flex-1 overflow-hidden rounded-xl border border-border bg-black/[0.03] ${
              active ? "min-h-[220px]" : "min-h-[8rem]"
            }`}
            aria-label={active ? "Camera scanner active" : "Camera preview area"}
          >
            <video
              ref={videoRef}
              playsInline
              autoPlay
              muted
              className={
                active
                  ? "h-full min-h-[220px] w-full object-cover rounded-xl"
                  : "hidden"
              }
            />
            {active ? (
              <div
                className="pointer-events-none absolute inset-0 flex items-center justify-center p-6"
                aria-hidden="true"
              >
                <div className="h-40 w-40 rounded-2xl border-2 border-emerald-500/70 ring-1 ring-emerald-400/40" />
              </div>
            ) : null}
            {!active ? (
              <div className="flex h-full min-h-[8rem] items-center justify-center px-3 text-center text-sm text-muted">
                Camera preview appears here
              </div>
            ) : null}
          </div>
          {!active ? (
            <Button
              type="button"
              disabled={Boolean(disabledReason) || assigning || looking || starting}
              onClick={() => void start()}
            >
              {starting ? "Opening camera…" : "Open camera"}
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              disabled={assigning || looking}
              onClick={() => void stopScanner()}
            >
              Stop camera
            </Button>
          )}
        </div>

        <form
          onSubmit={(e) => void openManual(e)}
          className="flex min-h-[16rem] flex-col gap-2 rounded-2xl border border-border bg-card p-3"
        >
          <p className="text-sm font-semibold text-foreground">
            Registration number
          </p>
          <p className="text-xs text-muted">
            Equal path to the camera — type when light is poor or permission is
            blocked.
          </p>
          <Input
            label="Reg no"
            inputMode="numeric"
            enterKeyHint="go"
            placeholder="e.g. 1001"
            disabled={Boolean(disabledReason) || assigning || looking}
            value={manual}
            onChange={(e) => setManual(e.target.value)}
          />
          <div className="mt-auto">
            <Button
              type="submit"
              disabled={looking || assigning || Boolean(disabledReason)}
            >
              {looking ? "Looking up…" : "Look up patient"}
            </Button>
          </div>
        </form>
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
            {mode !== "doctor" ? (
              <Link
                href={`/print/${assigned.id}`}
                className="pressable inline-flex min-h-11 items-center justify-center rounded-xl border border-border bg-white px-4 text-sm font-semibold text-brand hover:bg-white/90"
              >
                Reprint form
              </Link>
            ) : null}
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
        <div
          ref={reviewRef}
          tabIndex={-1}
          role="region"
          aria-live="polite"
          aria-atomic="true"
          aria-labelledby={reviewHeadingId}
          className="rounded-xl border border-border bg-card px-4 py-3 outline-none focus:ring-2 focus:ring-brand/30"
        >
          <p id={reviewHeadingId} className="font-bold text-foreground">
            <span className="tabular text-brand">#{lookup.reg_no}</span> ·{" "}
            {lookup.full_name}
          </p>
          {lookup.queue_status === "registered" && mode !== "doctor" ? (
            <>
              <p className="mt-1 text-sm text-muted">
                Still pre-registered (check-in may have failed). Use Check-in on
                the desk, or print the slip to check in.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link
                  href={`/print/${lookup.id}`}
                  aria-disabled={assigning}
                  tabIndex={assigning ? -1 : undefined}
                  onClick={(event) => {
                    if (assigning) event.preventDefault();
                  }}
                  className={`pressable inline-flex min-h-11 items-center justify-center rounded-xl border border-border bg-white px-4 text-sm font-semibold text-brand hover:bg-brand-soft ${
 assigning ? "pointer-events-none opacity-50" : ""
 }`}
                >
                  Print (check-in)
                </Link>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="w-auto"
                  disabled={assigning || looking}
                  onClick={resetResult}
                >
                  Cancel
                </Button>
              </div>
            </>
          ) : null}

          {lookup.queue_status === "seen" ? (
            <>
              <WarningBox>
                <div className="flex items-start gap-2.5">
                  <svg className="mt-0.5 h-5 w-5 shrink-0 text-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <div>
                    <p className="font-bold text-amber-950">
                      Already Seen{lookup.doctor_name ? ` by ${lookup.doctor_name}` : ""}
                    </p>
                    <p className="mt-0.5 text-xs text-amber-900/80">
                      Duplicate examination prevented. Multiple scans for the same patient are blocked.
                    </p>
                  </div>
                </div>
              </WarningBox>
              <div className="mt-3 flex flex-wrap gap-2">
                {mode !== "doctor" ? (
                  <Link
                    href={`/print/${lookup.id}`}
                    className="pressable inline-flex min-h-11 items-center justify-center rounded-xl border border-border bg-white px-4 text-sm font-semibold text-brand"
                  >
                    Reprint form
                  </Link>
                ) : null}
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
                  No doctors added yet.
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
                        disabled={assigning || looking}
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
                disabled={assigning || looking}
                onClick={resetResult}
              >
                Cancel
              </Button>
            </>
          ) : null}

          {(lookup.queue_status === "registered" ||
            lookup.queue_status === "waiting") &&
          mode === "doctor" ? (
            <div className="mt-3 space-y-2">
              <p className="text-sm text-muted">
                Check the patient name and registration number before confirming.
              </p>
              <Button
                type="button"
                disabled={assigning}
                loading={assigning}
                onClick={() => void assignDoctor({ id: lookup.id }, null)}
              >
                {assigning ? "Marking seen…" : "Confirm patient · mark seen"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="w-auto"
                disabled={assigning || looking}
                onClick={resetResult}
              >
                Cancel
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {toastMsg ? (
        <Toast message={toastMsg} onClose={() => setToastMsg(null)} />
      ) : null}
    </div>
  );
}

