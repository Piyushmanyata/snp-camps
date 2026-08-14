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
import { QrCameraSession } from "@/lib/qr-camera-session";
import { QrDecodeOrchestrator } from "@/lib/qr-decode-orchestrator";
import {
  printPrescriptionWithRetries,
  lookupPatientScanWithRetries,
  markSeenWithRetries,
  searchDeskPatientsWithRetries,
  undoMarkSeenWithRetries,
  type DeskPatientSearchRow,
  type LookupRow,
  type MarkSeenRow,
} from "@/lib/desk-ops";
import { Button, ErrorBox, Input } from "@/components/ui";
import { showSuccessToast } from "@/lib/toast-bus";
import { useToastedError } from "@/lib/use-toasted-error";

type LookupOrigin = "camera" | "manual";

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
  campId,
  disabledReason,
}: {
  campId: string | null;
  disabledReason?: string;
}) {
  const router = useRouter();
  const uid = useId().replace(/:/g, "");
  const reviewHeadingId = `qr-review-heading-${uid}`;
  const [error, setError] = useToastedError(null);
  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [manual, setManual] = useState("");
  const [nameMatches, setNameMatches] = useState<DeskPatientSearchRow[]>([]);
  const [looking, setLooking] = useState(false);
  const [lookup, setLookup] = useState<LookupRow | null>(null);
  const [seen, setSeen] = useState<MarkSeenRow | null>(null);
  const [assigning, setAssigning] = useState(false);

  const handledRef = useRef(false);
  const autoScanDone = useRef(false);
  const badScanAt = useRef(0);
  const isMounted = useRef(true);
  const lookupOriginRef = useRef<LookupOrigin>("manual");
  const lastCameraRawRef = useRef<string | null>(null);
  const cameraSessionRef = useRef(new QrCameraSession());
  const decodeOrchRef = useRef<QrDecodeOrchestrator | null>(null);
  const sessionTokenRef = useRef(0);
  const decodeOptionsRef = useRef<{
    detector?: BarcodeDetectorInstance;
    jsQR?: JsQrFn;
  } | null>(null);
  const restartDecodeLoopRef = useRef<(() => void) | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const reviewRef = useRef<HTMLDivElement | null>(null);
  const firstNameMatchRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (nameMatches.length > 0) firstNameMatchRef.current?.focus();
  }, [nameMatches]);
  const assigningRef = useRef(false);

  const cancelAnimation = useCallback(() => {
    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
  }, []);

  const stopScanner = useCallback(async () => {
    cameraSessionRef.current.invalidate();
    sessionTokenRef.current = cameraSessionRef.current.token;
    cancelAnimation();
    decodeOrchRef.current = null;
    decodeOptionsRef.current = null;
    restartDecodeLoopRef.current = null;
    lastCameraRawRef.current = null;

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    if (isMounted.current) {
      setActive(false);
      setStarting(false);
    }
  }, [cancelAnimation]);

  useEffect(() => {
    isMounted.current = true;
    const session = cameraSessionRef.current;
    return () => {
      isMounted.current = false;
      session.invalidate();
      cancelAnimation();
      decodeOrchRef.current = null;
    };
  }, [cancelAnimation]);

  const readyForNext = useCallback(() => {
    setLookup(null);
    setSeen(null);
    setManual("");
    setNameMatches([]);
    handledRef.current = false;
  }, []);

  const deskRpc = useCallback(
    (supabase: ReturnType<typeof createClient>) =>
      async (fn: string, args: Record<string, unknown>) => {
        const result = await supabase.rpc(fn, args);
        return {
          data: result.data,
          error: result.error
            ? {
                message: result.error.message,
                code: result.error.code,
                details: result.error.details,
                hint: result.error.hint,
              }
            : null,
        };
      },
    [],
  );

  const markSeen = useCallback(
    async (opts: { id?: string; regNo?: number }) => {
      if (assigningRef.current) return null;
      assigningRef.current = true;
      setAssigning(true);
      setError(null);

      const outcome = await markSeenWithRetries({
        patientId: opts.id ?? null,
        regNo: opts.regNo ?? null,
        rpc: deskRpc(createClient()),
        errorContext: "qr-scanner.mark-seen",
        errorFallback: "Could not mark this patient seen. Try again.",
      });

      if (!outcome.ok) {
        setError(outcome.error);
        assigningRef.current = false;
        setAssigning(false);
        return null;
      }

      const row = outcome.row;

      try {
        if (typeof window !== "undefined" && "vibrate" in navigator) {
          navigator.vibrate(80);
        }
      } catch {}

      setSeen(row);
      setLookup(null);
      setManual("");
      showSuccessToast(
        row.already_seen
          ? `#${row.reg_no} pehle se dekha hua tha`
          : `#${row.reg_no} dekha hua ho gaya`,
      );
      handledRef.current = true;
      await stopScanner();
      router.refresh();
      assigningRef.current = false;
      setAssigning(false);
      return row;
    },
    [deskRpc, router, setError, stopScanner],
  );

  const printPrescription = useCallback(
    async (row: LookupRow) => {
      if (assigningRef.current) return;
      assigningRef.current = true;
      setAssigning(true);
      setError(null);

      const outcome = await printPrescriptionWithRetries({
        patientId: row.id,
        regNo: null,
        rpc: deskRpc(createClient()),
        errorContext: "qr-scanner.print-prescription",
      });

      if (!outcome.ok) {
        setError(outcome.error);
        assigningRef.current = false;
        setAssigning(false);
        return;
      }

      assigningRef.current = false;
      setAssigning(false);
      await stopScanner();
      router.push(`/print/${row.id}?auto=1`);
    },
    [deskRpc, router, setError, stopScanner],
  );

  const undoSeen = useCallback(
    async (patientId: string) => {
      if (assigningRef.current) return;
      assigningRef.current = true;
      setAssigning(true);
      setError(null);

      const outcome = await undoMarkSeenWithRetries({
        patientId,
        rpc: deskRpc(createClient()),
        errorContext: "qr-scanner.undo-mark-seen",
      });

      if (!outcome.ok) {
        setError(outcome.error);
      } else {
        showSuccessToast("Wapas registered kar diya");
        readyForNext();
        router.refresh();
      }

      assigningRef.current = false;
      setAssigning(false);
    },
    [deskRpc, readyForNext, router, setError],
  );

  const resolvePatient = useCallback(
    async (
      opts: { id?: string; regNo?: number },
      origin: LookupOrigin = lookupOriginRef.current,
    ) => {
      if (assigningRef.current) return null;
      lookupOriginRef.current = origin;
      setError(null);
      setLookup(null);
      setSeen(null);
      // `manual` reg input is not cleared here — survives failure (#32).

      const supabase = createClient();
      const outcome = await lookupPatientScanWithRetries({
        patientId: opts.id ?? null,
        regNo: opts.regNo ?? null,
        rpc: async (fn, args) => {
          const result = await supabase.rpc(fn, args);
          return {
            data: result.data,
            error: result.error
              ? {
                  message: result.error.message,
                  code: result.error.code,
                  details: result.error.details,
                  hint: result.error.hint,
                }
              : null,
          };
        },
        errorContext: "qr-scanner.lookup",
        errorFallback: "Could not look up this patient. Try again.",
      });

      if (!outcome.ok) {
        if (origin === "camera") {
          decodeOrchRef.current?.freeze();
          handledRef.current = true;
        } else {
          handledRef.current = false;
        }
        setError(outcome.error);
        return null;
      }

      const row = outcome.row;

      await stopScanner();

      try {
        if (typeof window !== "undefined" && "vibrate" in navigator) {
          navigator.vibrate(40);
        }
      } catch {}

      setLookup(row);
      handledRef.current = true;
      return row;
    },
    [setError, stopScanner],
  );

  useEffect(() => {
    if (!lookup) return;
    const frame = window.requestAnimationFrame(() => reviewRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [lookup]);

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
        const next = window.location.pathname;
        window.history.replaceState(null, "", next);
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [resolvePatient, setError]);

  function onDecodedText(decoded: string) {
    if (handledRef.current) return;
    const id = parsePatientIdFromQr(decoded);
    if (id) {
      handledRef.current = true;
      lastCameraRawRef.current = decoded;
      lookupOriginRef.current = "camera";
      decodeOrchRef.current?.pause();
      void resolvePatient({ id }, "camera");
      return;
    }
    const now = Date.now();
    if (now - badScanAt.current > 2500) {
      badScanAt.current = now;
      if (isMounted.current) {
        setError(
          "That QR is not a patient staff-scan code. Enter the registration number or name beside the camera.",
        );
      }
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
    } catch {}
  }

  async function openCameraStream(token: number): Promise<MediaStream | null> {
    const stream = await cameraSessionRef.current.acquire(
      token,
      (constraints) => navigator.mediaDevices.getUserMedia(constraints),
      {
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: SCANNER_VIDEO_WIDTH },
          height: { ideal: SCANNER_VIDEO_HEIGHT },
        },
        audio: false,
      },
    );
    if (stream) return stream;
    if (
      cameraSessionRef.current.isCurrent(token) &&
      isMounted.current
    ) {
      setError(
        "Camera unavailable or permission denied. Enter the registration number or name beside the camera.",
      );
      setActive(false);
      setStarting(false);
    }
    return null;
  }

  function startDecodeLoop(
    token: number,
    options: {
      detector?: BarcodeDetectorInstance;
      jsQR?: JsQrFn;
    },
  ) {
    decodeOptionsRef.current = options;
    cancelAnimation();

    const orch = new QrDecodeOrchestrator({
      isLive: () =>
        isMounted.current && cameraSessionRef.current.isCurrent(token),
      onDecoded: onDecodedText,
    });
    decodeOrchRef.current = orch;

    const canvasFull = document.createElement("canvas");
    const canvasHalf = document.createElement("canvas");
    const ctxFull = canvasFull.getContext("2d", { willReadFrequently: true });
    const ctxHalf = canvasHalf.getContext("2d", { willReadFrequently: true });
    let lastFrameTime = 0;
    let scaleTick = 0;
    let consecutiveFrameErrors = 0;

    const processFrame = async () => {
      if (
        !cameraSessionRef.current.isCurrent(token) ||
        !isMounted.current ||
        !videoRef.current
      ) {
        return;
      }

      const now = performance.now();
      if (now - lastFrameTime >= SCANNER_FRAME_INTERVAL_MS) {
        lastFrameTime = now;
        const video = videoRef.current;
        if (video.readyState >= 2 && orch.shouldRunFrame()) {
          try {
            if (options.detector) {
              const hit = await orch.runNativeDetect(video, (source) =>
                options.detector!.detect(source),
              );
              if (hit) return;
              if (
                ctxFull &&
                ctxHalf &&
                video.videoWidth > 0 &&
                orch.shouldRunFrame()
              ) {
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
                  if (
                    await orch.runNativeDetect(canvasFull, (source) =>
                      options.detector!.detect(source),
                    )
                  ) {
                    return;
                  }
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
                  if (
                    await orch.runNativeDetect(canvasHalf, (source) =>
                      options.detector!.detect(source),
                    )
                  ) {
                    return;
                  }
                }
              }
            } else if (options.jsQR && ctxFull && video.videoWidth > 0) {
              const vw = video.videoWidth;
              const vh = video.videoHeight;
              const dw = Math.max(320, Math.floor(vw / 2));
              const dh = Math.max(240, Math.floor(vh / 2));
              ensureCanvasSize(canvasFull, dw, dh);
              ctxFull.drawImage(video, 0, 0, dw, dh);
              const imageData = ctxFull.getImageData(0, 0, dw, dh);
              const text = decodeQrFromImageData(options.jsQR, imageData);
              if (orch.runSyncDecode(text)) return;
            }
            consecutiveFrameErrors = 0;
          } catch {
            consecutiveFrameErrors += 1;
            if (consecutiveFrameErrors >= 5) {
              await stopScanner();
              if (isMounted.current) {
                setError(
                  "Camera decoding stopped. Enter the registration number or name beside the camera.",
                );
              }
              return;
            }
          }
        }
      }

      if (
        cameraSessionRef.current.isCurrent(token) &&
        isMounted.current &&
        !orch.isPaused &&
        !orch.isFrozen
      ) {
        animFrameRef.current = requestAnimationFrame(() => {
          void processFrame();
        });
      }
    };

    restartDecodeLoopRef.current = () => {
      if (
        !cameraSessionRef.current.isCurrent(token) ||
        !decodeOptionsRef.current
      ) {
        return;
      }
      cancelAnimation();
      animFrameRef.current = requestAnimationFrame(() => {
        void processFrame();
      });
    };

    animFrameRef.current = requestAnimationFrame(() => {
      void processFrame();
    });
  }

  async function start() {
    if (starting || active || looking || assigningRef.current) return;
    const session = cameraSessionRef.current;
    const token = session.begin();
    sessionTokenRef.current = token;
    setError(null);
    setLookup(null);
    setSeen(null);
    setNameMatches([]);
    handledRef.current = false;
    badScanAt.current = 0;
    lastCameraRawRef.current = null;
    decodeOrchRef.current?.unfreeze();
    setStarting(true);
    setActive(true);

    try {
      const useNative = await canUseNativeQrDetector();
      if (!isMounted.current || !session.isCurrent(token)) return;

      if (useNative) {
        const Ctor = getBarcodeDetectorConstructor();
        if (Ctor) {
          const stream = await openCameraStream(token);
          if (!stream) return;
          await applyBestEffortCameraConstraints(stream);
          if (!videoRef.current) {
            throw new Error("Camera preview is unavailable");
          }
          videoRef.current.srcObject = stream;
          videoRef.current.setAttribute("playsinline", "true");
          await videoRef.current.play();
          if (!isMounted.current || !session.isCurrent(token)) {
            session.stopTracks();
            return;
          }
          const detector = new Ctor({ formats: ["qr_code"] });
          startDecodeLoop(token, { detector });
          if (session.isCurrent(token) && isMounted.current) setStarting(false);
          return;
        }
      }

      let jsQR: JsQrFn;
      try {
        jsQR = await loadJsQr();
      } catch {
        if (session.isCurrent(token) && isMounted.current) {
          await stopScanner();
          setError(
            "QR decoder could not load. Enter the registration number or name beside the camera.",
          );
        }
        return;
      }
      if (!isMounted.current || !session.isCurrent(token)) return;

      const stream = await openCameraStream(token);
      if (!stream) return;
      await applyBestEffortCameraConstraints(stream);
      if (!videoRef.current) {
        throw new Error("Camera preview is unavailable");
      }
      videoRef.current.srcObject = stream;
      videoRef.current.setAttribute("playsinline", "true");
      await videoRef.current.play();
      if (!isMounted.current || !session.isCurrent(token)) {
        session.stopTracks();
        return;
      }
      startDecodeLoop(token, { jsQR });
    } catch (e) {
      if (!session.isCurrent(token) || !isMounted.current) return;
      await stopScanner();
      setError(
        e instanceof Error
          ? e.message
          : "Camera failed. Enter the registration number or name beside the camera.",
      );
      setActive(false);
    } finally {
      if (session.isCurrent(token) && isMounted.current) setStarting(false);
    }
  }

  async function openManual(e: React.FormEvent) {
    e.preventDefault();
    if (looking || assigningRef.current) return;
    setLooking(true);
    setError(null);
    setLookup(null);
    setSeen(null);
    handledRef.current = false;
    lookupOriginRef.current = "manual";
    decodeOrchRef.current?.unfreeze();
    const raw = manual.trim();

    const cleanedRaw = raw.trim();
    if (!cleanedRaw) {
      setError("Enter a registration number or patient name.");
      setLooking(false);
      return;
    }
    if (cleanedRaw && !/^\d+$/.test(cleanedRaw)) {
      const asId = parsePatientIdFromQr(cleanedRaw);
      if (asId) {
        await resolvePatient({ id: asId }, "manual");
        setLooking(false);
        return;
      }
      if (cleanedRaw.length < 2 || !campId) {
        setError("Type at least 2 letters of the patient's name.");
        setLooking(false);
        return;
      }
      const outcome = await searchDeskPatientsWithRetries({
        campId,
        query: cleanedRaw,
        rpc: deskRpc(createClient()),
        errorContext: "qr-scanner.name-search",
      });
      if (!outcome.ok) {
        setError(outcome.error);
      } else if (outcome.rows.length === 0) {
        setError("No patient matches that name in the active camp.");
      } else {
        setNameMatches(outcome.rows);
        setLooking(false);
        return;
      }
      setLooking(false);
      return;
    }

    const reg = parseRegistrationNumber(raw);
    if (reg === null) {
      setError("Enter registration number (e.g. 1001).");
      setLooking(false);
      return;
    }

    await resolvePatient({ regNo: reg }, "manual");
    setLooking(false);
  }

  function resetResult() {
    if (assigningRef.current) return;
    setError(null);
    readyForNext();
    const orch = decodeOrchRef.current;
    if (orch?.isFrozen) {
      orch.unfreeze();
      handledRef.current = false;
    }
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
        <strong className="text-foreground">Scan</strong> the paper or phone QR,
        or enter their registration number or name. Then{" "}
        <strong className="text-foreground">Print prescription</strong> — that
        prints the paper and records that they arrived — or{" "}
        <strong className="text-foreground">Mark seen</strong> after the
        consultation. A patient already seen is refused.
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
              {starting ? "Opening camera…" : "Camera kholein"}
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              disabled={assigning || looking}
              onClick={() => void stopScanner()}
            >
              Camera band karein
            </Button>
          )}
        </div>

        <form
          onSubmit={(e) => void openManual(e)}
          className="flex min-h-[16rem] flex-col gap-2 rounded-2xl border border-border bg-card p-3"
        >
          <p className="text-sm font-semibold text-foreground">Type patient</p>
          <p className="text-xs text-muted">
            Enter their registration number or type their name.
          </p>
          <Input
            label="Registration number ya naam"
            enterKeyHint="go"
            placeholder="e.g. 1001 or Ramesh"
            disabled={Boolean(disabledReason) || assigning || looking}
            value={manual}
            onChange={(e) => {
              setManual(e.target.value);
              setNameMatches([]);
            }}
          />
          {nameMatches.length > 0 ? (
            <>
              <p className="sr-only" role="status" aria-live="polite">
                {nameMatches.length} matching{" "}
                {nameMatches.length === 1 ? "patient" : "patients"} found.
                Focus moved to the first result.
              </p>
              <ul
                className="divide-y divide-border overflow-hidden rounded-xl border border-border"
                aria-label="Matching patients"
              >
                {nameMatches.map((patient, index) => (
                  <li key={patient.id}>
                    <button
                      ref={index === 0 ? firstNameMatchRef : undefined}
                      type="button"
                      disabled={looking || assigning}
                      onClick={() => {
                        setNameMatches([]);
                        void resolvePatient({ id: patient.id }, "manual");
                      }}
                      className="pressable flex min-h-12 w-full flex-col items-start justify-center px-3 py-2 text-left hover:bg-brand-soft disabled:opacity-50"
                    >
                      <span className="font-semibold text-foreground">
                        <span className="tabular text-brand">
                          #{patient.reg_no}
                        </span>{" "}
                        {patient.full_name}
                      </span>
                      <span className="text-xs text-muted">
                        {patient.age != null ? `Age ${patient.age}` : "Age —"}
                        {patient.address ? ` · ${patient.address}` : ""}
                        {` · ${patient.queue_status}`}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <div className="mt-auto">
            <Button
              type="submit"
              disabled={looking || assigning || Boolean(disabledReason)}
            >
              {looking ? "Searching…" : "Dhundein"}
            </Button>
          </div>
        </form>
      </div>

      <ErrorBox message={error} />

      {seen ? (
        <div
          className="rounded-xl border border-brand/20 bg-brand-soft px-4 py-3"
          role="status"
          aria-live="polite"
          data-testid="seen-result"
        >
          <p className="text-sm font-semibold text-brand">
            {seen.already_seen ? "Already seen" : "Marked seen"}
          </p>
          <p className="mt-0.5 font-bold text-foreground">
            <span className="tabular">#{seen.reg_no}</span> · {seen.full_name}
          </p>
          {seen.seen_at ? (
            <p className="mt-1 text-sm text-brand">
              {seen.already_seen ? "Seen at " : "At "}
              {new Date(seen.seen_at).toLocaleTimeString("en-IN", {
                hour: "2-digit",
                minute: "2-digit",
              })}
              {seen.seen_by_name ? ` · by ${seen.seen_by_name}` : ""}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href={`/print/${seen.id}`}
              className="pressable inline-flex min-h-12 items-center justify-center rounded-xl border border-border bg-white px-4 text-sm font-semibold text-brand hover:bg-white/90"
            >
              Reprint prescription
            </Link>
            {!seen.already_seen ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="w-auto"
                disabled={assigning}
                onClick={() => void undoSeen(seen.id)}
              >
                Wapas registered karein
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-auto"
              onClick={resetResult}
            >
              Scan next
            </Button>
          </div>
        </div>
      ) : null}

      {lookup && !seen ? (
        <div
          ref={reviewRef}
          tabIndex={-1}
          role="region"
          aria-live="polite"
          aria-labelledby={reviewHeadingId}
          className="rounded-xl border border-border bg-card px-4 py-3"
          data-testid="scan-review"
        >
          <p className="text-sm font-semibold text-muted">
            Check this is the right patient
          </p>
          <p
            id={reviewHeadingId}
            className="mt-0.5 text-lg font-bold text-foreground"
          >
            <span className="tabular text-brand">#{lookup.reg_no}</span>{" "}
            {lookup.full_name}
          </p>
          {lookup.phone ? (
            <p className="text-sm text-muted">{lookup.phone}</p>
          ) : null}

          {lookup.queue_status === "seen" ? (
            <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5">
              <p className="text-sm font-semibold text-amber-950">
                Already seen
                {lookup.seen_at
                  ? ` at ${new Date(lookup.seen_at).toLocaleTimeString("en-IN", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}`
                  : ""}
                {lookup.seen_by_name ? ` by ${lookup.seen_by_name}` : ""}
              </p>
              <p className="mt-0.5 text-xs text-amber-900">
                Nothing more to do here. Reprint if they need another form.
              </p>
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="lg"
              className="w-auto flex-1 sm:flex-none"
              disabled={assigning}
              loading={assigning}
              data-testid="print-prescription"
              onClick={() => void printPrescription(lookup)}
            >
              Parchi print karein
            </Button>

            {lookup.queue_status !== "seen" && lookup.printed_at ? (
              <Button
                type="button"
                size="lg"
                className="w-auto flex-1 sm:flex-none"
                disabled={assigning}
                loading={assigning}
                data-testid="mark-seen"
                onClick={() => void markSeen({ id: lookup.id })}
              >
                {assigning ? "Marking seen…" : "Dekha hua karein"}
              </Button>
            ) : null}

            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-auto"
              disabled={assigning || looking}
              onClick={resetResult}
            >
              Wrong patient
            </Button>
          </div>
        </div>
      ) : null}

    </div>
  );
}

