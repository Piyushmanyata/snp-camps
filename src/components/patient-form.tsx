"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import {
  digitsOnly,
  formatAadhaarDisplay,
  isValidAadhaarNumber,
  type AadhaarProfile,
} from "@/lib/aadhaar";
import {
  acquireDeskPrintTarget,
  patientPrintPath,
  runDeskRegisterAndPrint,
  type DeskSubmitPhase,
} from "@/lib/desk-register-flow";
import {
  createRegistrationAttempt,
} from "@/lib/registration-request";
import { createRequestId } from "@/lib/request-id";
import {
  validatePatientForm,
  type PatientFormField,
} from "@/lib/patient-form-validate";
import { checkInPatientWithRetries } from "@/lib/desk-ops";
import { formatCampDay, type CampDayStats } from "@/lib/types";
import {
  Button,
  ErrorBox,
  Input,
  SegmentedControl,
  WarningBox,
} from "@/components/ui";
import { parseAadhaarQrAsync, isNonLatinText } from "@/lib/aadhaar-qr";
import {
  applyBestEffortCameraConstraints,
  canUseNativeQrDetector,
  decodeQrPayloadFromImageData,
  getBarcodeDetectorConstructor,
  type BarcodeDetectorInstance,
  type JsQrFn,
  type JsQrOptions,
} from "@/lib/qr-detector";
import { QrCameraSession } from "@/lib/qr-camera-session";

/** Dense Aadhaar QR needs pixels; cap decode work to keep the loop responsive. */
const SCAN_FPS = 12;
const SCAN_FRAME_INTERVAL_MS = 1000 / SCAN_FPS;
/** Live frames skip the inverted pass — roughly 2x faster, and Aadhaar is never inverted. */
const LIVE_JSQR_OPTIONS: JsQrOptions = { inversionAttempts: "dontInvert" };
const UPLOAD_JSQR_OPTIONS: JsQrOptions = { inversionAttempts: "attemptBoth" };

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

/** Recoverable print action after a successful registration (#62 / #64). */
type PrintRecovery = {
  patientId: string;
  regNo: number;
  queueStatus?: "registered" | "waiting" | "seen";
  /** True only when the pre-opened target was navigated successfully. */
  printNavigated: boolean;
  printHref: string;
};

type Props = {
  campId: string;
  days: CampDayStats[];
  defaultPhone?: string;
  createdBy?: string | null;
  /** Volunteer/admin desk registration — print only, no on-screen QR */
  isStaff?: boolean;
  userRole?: string | null;
};

type FormFieldErrors = Partial<Record<PatientFormField, string>>;
type LookupState = "idle" | "loading" | "ok" | "fail" | "skipped";

export function PatientForm({
  campId,
  days,
  defaultPhone = "",
  createdBy = null,
  isStaff = false,
}: Props) {
  const openDays = days.filter((d) => !d.is_full);
  const firstOpen = openDays[0]?.id || "";

  const [campDayId, setCampDayId] = useState(firstOpen);
  const [aadhaar, setAadhaar] = useState("");
  const [aadhaarHash, setAadhaarHash] = useState<string | null>(null);
  const [aadhaarVerifiedAt, setAadhaarVerifiedAt] = useState<string | null>(null);
  const [aadhaarKycRef, setAadhaarKycRef] = useState<string | null>(null);
  const [fullName, setFullName] = useState("");
  const [gender, setGender] = useState("");
  const [age, setAge] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState(defaultPhone);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [aadhaarDuplicateRegNo, setAadhaarDuplicateRegNo] = useState<
    number | null
  >(null);
  const [likelyDuplicateRegNo, setLikelyDuplicateRegNo] = useState<
    number | null
  >(null);
  const [provenance, setProvenance] = useState<
    "self_declared" | "card_verified" | "ekyc_verified"
  >("self_declared");
  const initialVerifiedValuesRef = useRef<{
    fullName: string;
    aadhaarLast4: string;
  } | null>(null);
  const aadhaarOverrideOnceRef = useRef(false);
  const likelyOverrideOnceRef = useRef(false);
  const formRef = useRef<HTMLFormElement | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FormFieldErrors>({});
  const [loading, setLoading] = useState(false);
  /** idle | saving | failed-retryable | registered-print-ready (#62). */
  const [phase, setPhase] = useState<DeskSubmitPhase>("idle");
  const [printRecovery, setPrintRecovery] = useState<PrintRecovery | null>(
    null,
  );

  const [lookupState, setLookupState] = useState<LookupState>("idle");
  const [lookupMsg, setLookupMsg] = useState<string | null>(null);
  const registrationAttempt = useRef(
    createRegistrationAttempt(createRequestId),
  );

  const [isScanningQr, setIsScanningQr] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scannedBanner, setScannedBanner] = useState<string | null>(null);
  const qrCameraSessionRef = useRef(new QrCameraSession());
  const qrVideoRef = useRef<HTMLVideoElement | null>(null);
  const qrAnimFrameRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const stopQrScanner = useCallback(() => {
    qrCameraSessionRef.current.invalidate();
    if (qrAnimFrameRef.current !== null) {
      cancelAnimationFrame(qrAnimFrameRef.current);
      qrAnimFrameRef.current = null;
    }
    if (qrVideoRef.current) {
      qrVideoRef.current.srcObject = null;
    }
    setIsScanningQr(false);
  }, []);

  useEffect(() => {
    const session = qrCameraSessionRef.current;
    return () => {
      session.invalidate();
      if (qrAnimFrameRef.current !== null) {
        cancelAnimationFrame(qrAnimFrameRef.current);
      }
    };
  }, []);

  /**
   * Try one decoded payload. Returns true when it filled the form.
   *
   * `requireUseful` keeps the camera running on a payload that decoded but
   * carried no autofillable field — a partial read on one blurry frame should
   * not end the session when the next frame may read cleanly.
   */
  const handleScannedPayload = useCallback(
    async (
      payload: string | Uint8Array,
      { requireUseful = false }: { requireUseful?: boolean } = {},
    ): Promise<boolean> => {
      let parsed;
      try {
        parsed = await parseAadhaarQrAsync(payload);
      } catch (err: unknown) {
        const msg =
          err instanceof Error ? err.message : "Invalid Aadhaar QR code.";
        // Non-Aadhaar QR (e.g. a desk slip) is terminal — tell the operator.
        // Anything else is just a bad frame; keep scanning.
        if (!requireUseful || /desk slip/i.test(msg)) {
          setScanError(msg);
          setProvenance("self_declared");
          initialVerifiedValuesRef.current = null;
          stopQrScanner();
        }
        return false;
      }

      const useful =
        Boolean(parsed.fullName) || parsed.age != null || Boolean(parsed.gender);
      if (requireUseful && !useful) return false;

      if (parsed.fullName) setFullName(parsed.fullName);
      if (parsed.age != null) setAge(String(parsed.age));
      if (parsed.gender) setGender(parsed.gender);
      if (parsed.address) setAddress(parsed.address);
      if (parsed.aadhaarLast4) setAadhaar(parsed.aadhaarLast4);

      setProvenance("card_verified");
      initialVerifiedValuesRef.current = {
        fullName: parsed.fullName || "",
        aadhaarLast4: parsed.aadhaarLast4 || "",
      };

      const missingFields: string[] = [];
      if (!parsed.fullName) missingFields.push("name");
      if (parsed.age == null) missingFields.push("age");

      if (missingFields.length > 0) {
        setScannedBanner(
          `Aadhaar card scanned. Partial details autofilled. Please enter ${missingFields.join(" and ")} manually.`,
        );
      } else {
        setScannedBanner(
          "Aadhaar card scanned and autofilled. Phone number is not present in Aadhaar QR. Please enter phone number manually.",
        );
      }
      setScanError(null);
      stopQrScanner();
      return true;
    },
    [stopQrScanner],
  );

  const handleFileUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setScanError(null);

      try {
        const img = new Image();
        const url = URL.createObjectURL(file);
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error("Could not load image file."));
          img.src = url;
        });

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("Canvas unavailable.");

        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        // jsQR first for a still photo: it yields the raw bytes that a byte-mode
        // Secure QR needs, which BarcodeDetector's string cannot carry.
        const jsQR = await loadJsQr();
        let payload: string | Uint8Array | null = null;

        // Whole frame, then progressively tighter centre crops — a photographed
        // card usually sits mid-frame, and cropping raises effective resolution.
        for (const scale of [1, 0.75, 0.5]) {
          const cw = Math.floor(canvas.width * scale);
          const ch = Math.floor(canvas.height * scale);
          if (cw < 100 || ch < 100) continue;

          let data: ImageData;
          if (scale === 1) {
            data = ctx.getImageData(0, 0, canvas.width, canvas.height);
          } else {
            const sx = Math.floor((canvas.width - cw) / 2);
            const sy = Math.floor((canvas.height - ch) / 2);
            const cropCanvas = document.createElement("canvas");
            cropCanvas.width = cw;
            cropCanvas.height = ch;
            const cropCtx = cropCanvas.getContext("2d", { willReadFrequently: true });
            if (!cropCtx) continue;
            cropCtx.drawImage(canvas, sx, sy, cw, ch, 0, 0, cw, ch);
            data = cropCtx.getImageData(0, 0, cw, ch);
          }

          const decoded = decodeQrPayloadFromImageData(jsQR, data, UPLOAD_JSQR_OPTIONS);
          if (decoded) {
            payload = decoded.bytes ?? decoded.text;
            break;
          }
        }

        // Last resort: the platform detector may locate a code jsQR missed.
        if (!payload && (await canUseNativeQrDetector())) {
          const Ctor = getBarcodeDetectorConstructor();
          if (Ctor) {
            const detector = new Ctor({ formats: ["qr_code"] });
            const hits = await detector.detect(canvas).catch(() => []);
            if (hits.length > 0 && hits[0].rawValue) payload = hits[0].rawValue;
          }
        }

        URL.revokeObjectURL(url);

        if (payload) {
          await handleScannedPayload(payload);
        } else {
          setScanError("No Aadhaar QR code found in selected image. Please try a clearer photo.");
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Error reading photo file.";
        setScanError(msg);
      } finally {
        if (e.target) e.target.value = "";
      }
    },
    [handleScannedPayload],
  );

  const startQrScanner = useCallback(async () => {
    setScanError(null);
    setIsScanningQr(true);
    const token = qrCameraSessionRef.current.begin();

    const stream = await qrCameraSessionRef.current.acquire(
      token,
      (c) => navigator.mediaDevices.getUserMedia(c),
      {
        video: {
          facingMode: { ideal: "environment" },
          // A 137-module Secure QR needs pixels per module; 720p is marginal.
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      },
    );

    if (!stream || !qrCameraSessionRef.current.isCurrent(token)) {
      setScanError(
        "Camera unavailable or permission denied. Please type details manually.",
      );
      setIsScanningQr(false);
      return;
    }

    // Continuous autofocus is the single biggest factor in whether a dense
    // Aadhaar QR resolves at all.
    await applyBestEffortCameraConstraints(stream);

    // jsQR is always loaded: it is the only decoder that returns raw bytes, and
    // Secure QR is byte-mode binary. The platform detector is an extra fast path.
    let jsQR: JsQrFn | undefined;
    try {
      jsQR = await loadJsQr();
    } catch {
      jsQR = undefined;
    }

    let detector: BarcodeDetectorInstance | undefined;
    if (await canUseNativeQrDetector()) {
      const Ctor = getBarcodeDetectorConstructor();
      if (Ctor) detector = new Ctor({ formats: ["qr_code"] });
    }

    if (!jsQR && !detector) {
      setScanError(
        "Scanner fallback unavailable. Please type details manually.",
      );
      stopQrScanner();
      return;
    }

    if (qrVideoRef.current) {
      qrVideoRef.current.srcObject = stream;
      await qrVideoRef.current.play().catch(() => {});
    }

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const cropCanvas = document.createElement("canvas");
    const cropCtx = cropCanvas.getContext("2d", { willReadFrequently: true });
    let frameTick = 0;
    let lastFrameAt = 0;
    let busy = false;

    const decodeRegion = (scale: number): string | Uint8Array | null => {
      if (!jsQR || !ctx || !video()) return null;
      const v = video()!;
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);

      let data: ImageData;
      if (scale >= 1) {
        data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      } else {
        const cw = Math.floor(canvas.width * scale);
        const ch = Math.floor(canvas.height * scale);
        if (cw < 100 || ch < 100 || !cropCtx) return null;
        cropCanvas.width = cw;
        cropCanvas.height = ch;
        cropCtx.drawImage(
          canvas,
          Math.floor((canvas.width - cw) / 2),
          Math.floor((canvas.height - ch) / 2),
          cw,
          ch,
          0,
          0,
          cw,
          ch,
        );
        data = cropCtx.getImageData(0, 0, cw, ch);
      }

      const decoded = decodeQrPayloadFromImageData(jsQR, data, LIVE_JSQR_OPTIONS);
      if (!decoded) return null;
      return decoded.bytes ?? decoded.text;
    };

    function video(): HTMLVideoElement | null {
      return qrVideoRef.current;
    }

    const processFrame = async () => {
      if (!qrCameraSessionRef.current.isCurrent(token) || !video()) return;

      const now = performance.now();
      // Throttle: an unthrottled rAF loop ran full-resolution decodes at 60fps,
      // starving the camera and making scanning slower, not faster.
      if (!busy && now - lastFrameAt >= SCAN_FRAME_INTERVAL_MS) {
        lastFrameAt = now;
        busy = true;
        try {
          const v = video()!;
          if (v.readyState >= 2 && v.videoWidth > 0) {
            frameTick += 1;

            // Platform detector: cheap, and enough for legacy text-mode cards.
            if (detector) {
              try {
                const hits = await detector.detect(v);
                const raw = hits[0]?.rawValue;
                if (
                  raw &&
                  (await handleScannedPayload(raw, { requireUseful: true }))
                ) {
                  return;
                }
              } catch {
                /* ignore frame detect error */
              }
            }

            // jsQR carries the bytes a Secure QR needs. Alternate whole-frame
            // and centre-crop passes so both far and near framing resolve.
            const payload = decodeRegion(frameTick % 2 === 0 ? 0.6 : 1);
            if (
              payload &&
              (await handleScannedPayload(payload, { requireUseful: true }))
            ) {
              return;
            }
          }
        } catch {
          /* keep scanning */
        } finally {
          busy = false;
        }
      }

      if (qrCameraSessionRef.current.isCurrent(token)) {
        qrAnimFrameRef.current = requestAnimationFrame(() => {
          void processFrame();
        });
      }
    };

    qrAnimFrameRef.current = requestAnimationFrame(() => {
      void processFrame();
    });
  }, [handleScannedPayload, stopQrScanner]);

  const focusName = useCallback(() => {
    requestAnimationFrame(() => {
      document.getElementById("patient-full-name")?.focus();
    });
  }, []);

  useEffect(() => {
    focusName();
  }, [focusName]);

  const applyProfile = useCallback((profile: AadhaarProfile) => {
    if (profile.full_name) setFullName(profile.full_name);
    if (profile.gender) setGender(profile.gender);
    if (profile.age != null) setAge(String(profile.age));
    if (profile.address) setAddress(profile.address);
    if (profile.phone) setPhone(profile.phone);
    if (profile.email) setEmail(profile.email);
  }, []);

  function onAadhaarChange(value: string) {
    const formatted = formatAadhaarDisplay(value);
    setAadhaar(formatted);
    const d = digitsOnly(formatted);
    setAadhaarHash(null);
    setAadhaarVerifiedAt(null);
    setAadhaarKycRef(null);
    if (
      provenance === "card_verified" &&
      initialVerifiedValuesRef.current &&
      d !== initialVerifiedValuesRef.current.aadhaarLast4
    ) {
      setProvenance("self_declared");
    }
    setLookupState(d.length >= 4 ? "skipped" : "idle");
    setLookupMsg(d.length >= 4 ? "Optional · sirf last 4 store hota hai." : null);
  }

  async function verifyAadhaarAtDesk() {
    const d = digitsOnly(aadhaar);
    if (!isValidAadhaarNumber(d)) {
      setLookupState("fail");
      setLookupMsg("Verify ke liye valid 12-digit Aadhaar chahiye.");
      return;
    }
    setLookupState("loading");
    setLookupMsg("OTP bhej rahe hain…");
    const init = await fetch("/api/aadhaar-kyc/initiate", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ aadhaar: d }),
    }).then((response) => response.json()).catch(() => null) as { ok?: boolean; handle?: string; error?: string } | null;
    if (!init?.ok || !init.handle) {
      setLookupState("skipped");
      setLookupMsg(init?.error || "Verification unavailable — form manually bhariye.");
      return;
    }
    const entered = window.prompt("Aadhaar-linked mobile par aaya 6-digit OTP daalein")?.replace(/\D/g, "") || "";
    if (entered.length !== 6) { setLookupState("fail"); setLookupMsg("OTP verify nahi hua. Form manually bhar sakte hain."); return; }
    const verified = await fetch("/api/aadhaar-kyc/verify", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: init.handle, otp: entered }),
    }).then((response) => response.json()).catch(() => null) as { ok?: boolean; profile?: AadhaarProfile; aadhaarHash?: string; aadhaarLast4?: string; providerRef?: string; phone?: string | null; error?: string } | null;
    if (!verified?.ok || !verified.profile || !verified.aadhaarHash || !verified.providerRef) {
      setLookupState("skipped"); setLookupMsg(verified?.error || "Verification fail — form manually bhariye."); return;
    }
    applyProfile(verified.profile);
    setAadhaar(verified.aadhaarLast4 || d.slice(-4));
    setAadhaarHash(verified.aadhaarHash);
    setAadhaarVerifiedAt(new Date().toISOString());
    setAadhaarKycRef(verified.providerRef);
    setProvenance("ekyc_verified");
    setLookupState("ok"); setLookupMsg("Aadhaar verified — details editable hain, correction allowed.");
  }

  function failValidation(
    field: PatientFormField,
    elementId: string,
    message: string,
  ) {
    setFieldErrors({ [field]: message });
    setError(message);
    setLoading(false);
    requestAnimationFrame(() => {
      document.getElementById(elementId)?.focus();
    });
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isStaff) return;

    setLoading(true);
    setPhase("saving");
    setError(null);
    setFlash(null);
    setFieldErrors({});
    // Keep prior print recovery until a new success replaces it —
    // never clear the only route to the slip mid-submit.
    const aadhaarDuplicateOverride = aadhaarOverrideOnceRef.current;
    aadhaarOverrideOnceRef.current = false;
    const likelyDuplicateOverride = likelyOverrideOnceRef.current;
    likelyOverrideOnceRef.current = false;
    if (!aadhaarDuplicateOverride) {
      setAadhaarDuplicateRegNo(null);
    }
    if (!likelyDuplicateOverride) {
      setLikelyDuplicateRegNo(null);
    }

    const validated = validatePatientForm(
      {
        campDayId,
        fullName,
        gender,
        age,
        address,
        phone,
        email,
        aadhaar,
      },
      days,
    );

    if (!validated.ok) {
      setPhase("idle");
      failValidation(validated.field, validated.elementId, validated.message);
      return;
    }

    if (isNonLatinText(fullName)) {
      setPhase("idle");
      failValidation(
        "fullName",
        "patient-full-name",
        "Scanned name is in a non-Latin script. Please enter the name in Latin script.",
      );
      return;
    }

    // Acquire print target during the submit gesture BEFORE any await (#62).
    // Do not pass noopener — retain handle, sever opener, navigate after save.
    const printTarget = acquireDeskPrintTarget((url, target, features) =>
      window.open(url, target, features),
    );

    const supabase = createClient();
    const resetFormFields = () => {
      setFullName("");
      setGender("");
      setAge("");
      setAddress("");
      setPhone(defaultPhone);
      setEmail("");
      setAadhaar("");
      setAadhaarHash(null);
      setAadhaarVerifiedAt(null);
      setAadhaarKycRef(null);
      setProvenance("self_declared");
      initialVerifiedValuesRef.current = null;
      setScannedBanner(null);
      setScanError(null);
      setLookupState("idle");
      setLookupMsg(null);
      setFieldErrors({});
      setAadhaarDuplicateRegNo(null);
      setLikelyDuplicateRegNo(null);
      aadhaarOverrideOnceRef.current = false;
      likelyOverrideOnceRef.current = false;
      setCampDayId(firstOpen);
      focusName();
    };

    const outcome = await runDeskRegisterAndPrint({
      attempt: registrationAttempt.current,
      staffFields: {
        campId,
        fullName: validated.values.fullName,
        gender: validated.values.gender,
        age: validated.values.age,
        address: validated.values.address,
        phone: validated.values.phone,
        email: validated.values.email,
        aadhaarLast4: validated.values.aadhaarLast4,
        aadhaarHash,
        aadhaarVerifiedAt,
        aadhaarKycRef,
        createdBy,
        campDayId: validated.values.campDayId,
        aadhaarDuplicateOverride,
        likelyDuplicateOverride,
        provenance,
      },
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
      printTarget,
      resetForm: resetFormFields,
      rotateAttempt: () => {
        registrationAttempt.current.rotate();
      },
      // Retain print recovery BEFORE form reset (#62 / #64).
      onSuccess: ({ row, print }) => {
        setPrintRecovery({
          patientId: row.id,
          regNo: row.reg_no,
          queueStatus: row.queue_status,
          printNavigated: print === "navigated",
          printHref: patientPrintPath(row.id),
        });
        setPhase("registered-print-ready");
        const queueBit =
          row.queue_status === "waiting" ? "line mein" : "register ho gaya";
        setFlash(
          print === "navigated"
            ? `Reg #${row.reg_no} — ${queueBit}. Print window open.`
            : `Reg #${row.reg_no} — ${queueBit}. Print blocked — use Print below.`,
        );
        setAadhaarDuplicateRegNo(null);
        setLikelyDuplicateRegNo(null);
      },
      // Registration SMS — never await; desk must not wait or error on SMS (#51).
      afterRegister: (row) => {
        void fetch("/api/notify/registration", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ patientId: row.id }),
        }).catch(() => {});
      },
    });

    if (!outcome.ok) {
      // Soft match first — volunteer can check in existing patient (#48).
      if (outcome.likelyDuplicateRegNo) {
        setLikelyDuplicateRegNo(outcome.likelyDuplicateRegNo);
        setAadhaarDuplicateRegNo(null);
        setError(null);
        setPhase("idle");
        setLoading(false);
        return;
      }
      if (outcome.aadhaarDuplicateRegNo) {
        setAadhaarDuplicateRegNo(outcome.aadhaarDuplicateRegNo);
        setLikelyDuplicateRegNo(null);
        setError(
          `Naam + Aadhaar last-4 pehle se reg #${outcome.aadhaarDuplicateRegNo} pe hai. Pehle woh patient dekho. Override sirf alag person ho to.`,
        );
        setPhase("idle");
      } else {
        setAadhaarDuplicateRegNo(null);
        setLikelyDuplicateRegNo(null);
        setError(outcome.error);
        // Explicit Try Again only for exhausted transient (#47 / #62).
        setPhase(outcome.showTryAgain ? "failed-retryable" : "idle");
      }
      setLoading(false);
      return;
    }

    // onSuccess already retained recovery + flash before reset.
    setLoading(false);
  }

  function openPrintRecovery() {
    if (!printRecovery) return;
    // User-gesture open — recovery never re-registers (#62).
    const href =
      printRecovery.printHref || patientPrintPath(printRecovery.patientId);
    window.open(href, "_blank");
  }

  function retryFailedRegistration() {
    if (loading || phase !== "failed-retryable") return;
    // Same form fields, camp day, overrides, and request ID (#62).
    formRef.current?.requestSubmit();
  }

  async function checkInLikelyDuplicate() {
    if (likelyDuplicateRegNo == null || loading) return;
    const regTarget = likelyDuplicateRegNo;
    setLoading(true);
    setError(null);
    setFlash(null);
    const supabase = createClient();
    const outcome = await checkInPatientWithRetries({
      patientId: null,
      regNo: regTarget,
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
      errorContext: "patient-form.check-in-likely-dup",
      errorFallback: "Could not check in this patient. Try again.",
    });
    if (!outcome.ok) {
      // Preserve likely-duplicate selection + form state for Try Again (#61).
      setError(outcome.error);
      setLoading(false);
      return;
    }
    const row = outcome.row;
    const reg = row.reg_no ?? regTarget;
    setFlash(
      row.already_waiting
        ? `Reg #${reg} pehle se line mein hai. Naya register nahi banaya.`
        : `Reg #${reg} check-in ho gaya. Naya register nahi banaya.`,
    );
    setLikelyDuplicateRegNo(null);
    setAadhaarDuplicateRegNo(null);
    aadhaarOverrideOnceRef.current = false;
    likelyOverrideOnceRef.current = false;
    registrationAttempt.current.rotate();
    setFullName("");
    setGender("");
    setAge("");
    setAddress("");
    setPhone(defaultPhone);
    setEmail("");
    setAadhaar("");
    setProvenance("self_declared");
    initialVerifiedValuesRef.current = null;
    setLookupState("idle");
    setLookupMsg(null);
    setFieldErrors({});
    setCampDayId(firstOpen);
    setAadhaarHash(null);
    setAadhaarVerifiedAt(null);
    setAadhaarKycRef(null);
    focusName();
    setLoading(false);
  }

  function moveDay(currentId: string, direction: -1 | 1) {
    const selectable = days.filter((d) => !d.is_full);
    const currentIndex = selectable.findIndex((d) => d.id === currentId);
    if (currentIndex < 0 || selectable.length < 2) return;
    const next =
      selectable[
        (currentIndex + direction + selectable.length) % selectable.length
      ];
    setCampDayId(next.id);
    window.setTimeout(() => {
      document.getElementById(`camp-day-${next.id}`)?.focus();
    }, 0);
  }

  if (!isStaff) {
    return (
      <div className="space-y-3 rounded-2xl border border-border bg-card p-4">
        <p className="text-sm font-semibold text-foreground">
          Registration sirf camp desk pe
        </p>
        <p className="prose-help text-sm text-muted">
          Volunteer ke paas jao. Staff register karega, desk slip print hogi.
          Public online registration nahi hai.
        </p>
        <Link
          href="/"
          className="pressable inline-flex min-h-12 items-center justify-center rounded-xl border border-border bg-white px-4 text-sm font-semibold text-brand hover:bg-brand-soft"
        >
          Home
        </Link>
      </div>
    );
  }

  if (!days.length) {
    return (
      <p className="text-sm text-muted">
        Camp days nahi hain. Admin se days add karwao.
      </p>
    );
  }

  if (!openDays.length) {
    return (
      <WarningBox>
        Saare din full hain. Seats free hone ya admin limit badhane ka wait
        karo.
      </WarningBox>
    );
  }

  return (
    <form
      ref={formRef}
      onSubmit={onSubmit}
      className="space-y-3.5 sm:space-y-4"
      noValidate
    >
      <div className="rounded-xl border border-brand/15 bg-brand-soft/50 px-3.5 py-2.5 text-sm text-brand">
        Desk · sirf poora naam aur umar zaroori
      </div>

      {/* Aadhaar QR Scanner Action */}
      <div className="rounded-xl border border-brand/20 bg-brand-soft/30 p-3.5 space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-brand">
              Aadhaar QR Scan-and-Fill
            </p>
            <p className="text-xs text-muted">
              Scan or upload patient&apos;s Aadhaar card photo to auto-fill details
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="sm:w-auto"
              data-testid="scan-aadhaar-qr-button"
              onClick={isScanningQr ? stopQrScanner : () => void startQrScanner()}
            >
              {isScanningQr ? "Stop Scanner" : "Scan Aadhaar QR"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="sm:w-auto"
              data-testid="upload-aadhaar-qr-button"
              onClick={() => fileInputRef.current?.click()}
            >
              Upload Photo
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => void handleFileUpload(e)}
            />
          </div>
        </div>

        {isScanningQr ? (
          <div className="relative overflow-hidden rounded-xl bg-black aspect-video max-h-64 flex items-center justify-center">
            <video
              ref={qrVideoRef}
              playsInline
              muted
              autoPlay
              className="h-full w-full object-cover"
            />
            <div className="absolute inset-0 border-2 border-dashed border-white/60 pointer-events-none rounded-xl m-4 flex items-center justify-center">
              <span className="bg-black/60 px-3 py-1 text-xs text-white rounded-md font-medium">
                Point camera at Aadhaar QR code
              </span>
            </div>
          </div>
        ) : null}

        {scannedBanner ? (
          <div
            role="status"
            data-testid="aadhaar-scanned-banner"
            className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2.5 text-xs font-semibold text-blue-950"
          >
            {scannedBanner}
          </div>
        ) : null}

        {scanError ? (
          <div
            role="alert"
            data-testid="aadhaar-scan-error"
            className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs font-semibold text-red-950"
          >
            {scanError}
          </div>
        ) : null}
      </div>

      {flash ? (
        <p
          role="status"
          data-testid="desk-register-flash"
          className="rounded-xl border border-brand/20 bg-brand-soft px-3 py-2 text-sm font-medium text-brand"
        >
          {flash}
        </p>
      ) : null}

      {printRecovery ? (
        <div
          role="status"
          data-testid="desk-print-recovery"
          data-print-navigated={printRecovery.printNavigated ? "true" : "false"}
          data-patient-id={printRecovery.patientId}
          className="flex flex-col gap-2 rounded-xl border border-brand/20 bg-brand-soft/60 px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="min-w-0">
            <p className="text-sm font-semibold text-brand">
              Registered · #{printRecovery.regNo}
            </p>
            <p className="text-xs text-muted">
              {printRecovery.printNavigated
                ? "Print window opened. Reprint anytime without re-registering."
                : "Print was blocked or closed. Use Print — patient is already saved."}
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            className="sm:w-auto"
            data-testid="desk-print-recovery-button"
            onClick={openPrintRecovery}
          >
            Print desk slip
          </Button>
        </div>
      ) : null}

      <div>
        <p className="mb-1.5 text-[0.9375rem] font-semibold text-foreground/90">
          Camp day *
        </p>
        <div
          id="patient-camp-day"
          className="day-chip-row"
          role="radiogroup"
          aria-label="Camp day"
          aria-invalid={fieldErrors.campDay ? true : undefined}
          aria-describedby={
            fieldErrors.campDay ? "patient-camp-day-error" : undefined
          }
        >
          {days.map((d) => {
            const active = campDayId === d.id;
            return (
              <button
                key={d.id}
                id={`camp-day-${d.id}`}
                type="button"
                role="radio"
                aria-checked={active}
                tabIndex={active ? 0 : -1}
                disabled={d.is_full}
                onClick={() => setCampDayId(d.id)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                    e.preventDefault();
                    moveDay(d.id, 1);
                  } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                    e.preventDefault();
                    moveDay(d.id, -1);
                  }
                }}
                className={`day-chip ${active ? "day-chip-active" : ""} ${
                  d.is_full ? "day-chip-full" : ""
                }`}
              >
                <span className="day-chip-date">
                  {formatCampDay(d.day_date)}
                </span>
                <span className="day-chip-meta">
                  {d.is_full ? "FULL" : `${d.seats_left} left`}
                </span>
              </button>
            );
          })}
        </div>
        <select
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          required
          value={campDayId}
          onChange={(e) => setCampDayId(e.target.value)}
        >
          <option value="">Select day…</option>
          {days.map((d) => (
            <option key={d.id} value={d.id} disabled={d.is_full}>
              {formatCampDay(d.day_date)}
            </option>
          ))}
        </select>
        {fieldErrors.campDay ? (
          <p
            id="patient-camp-day-error"
            role="alert"
            className="mt-1.5 text-[0.8125rem] font-medium text-danger"
          >
            {fieldErrors.campDay}
          </p>
        ) : null}
      </div>

      <Input
        id="patient-full-name"
        label="Poora naam *"
        error={fieldErrors.fullName}
        required
        autoComplete="name"
        autoFocus
        enterKeyHint="next"
        value={fullName}
        onChange={(e) => {
          const val = e.target.value;
          setFullName(val);
          if (
            provenance === "card_verified" &&
            initialVerifiedValuesRef.current &&
            val !== initialVerifiedValuesRef.current.fullName
          ) {
            setProvenance("self_declared");
          }
        }}
        placeholder="Patient ka poora naam"
      />

      <Input
        id="patient-age"
        label="Umar *"
        error={fieldErrors.age}
        type="number"
        min={0}
        max={149}
        required
        inputMode="numeric"
        enterKeyHint="next"
        value={age}
        onChange={(e) => setAge(e.target.value)}
        placeholder="Saal"
      />

      <Input
        id="patient-phone"
        label="Mobile number (optional)"
        error={fieldErrors.phone}
        inputMode="numeric"
        autoComplete="tel"
        enterKeyHint="next"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        placeholder="10 digit (optional)"
        hint="Optional — SMS baad mein, agar number diya"
      />

      <Input
        id="patient-aadhaar"
        label="Aadhaar last 4 (optional)"
        error={fieldErrors.aadhaar}
        inputMode="numeric"
        autoComplete="off"
        placeholder="XXXX XXXX 1234"
        hint="Poora number kabhi store nahi — sirf last 4"
        value={aadhaar}
        onChange={(e) => onAadhaarChange(e.target.value)}
      />
      {isStaff && digitsOnly(aadhaar).length === 12 && !aadhaarVerifiedAt ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={lookupState === "loading"}
          onClick={() => void verifyAadhaarAtDesk()}
        >
          {lookupState === "loading" ? "Verifying…" : "Verify Aadhaar (optional)"}
        </Button>
      ) : null}
      {aadhaarVerifiedAt ? <p className="text-xs font-semibold text-brand">Aadhaar verified · staff can still edit details</p> : null}
      {lookupMsg ? (
        <p
          role="status"
          className={`rounded-xl px-3 py-2 text-xs ${
            lookupState === "ok"
              ? "bg-brand-soft text-brand"
              : lookupState === "fail"
                ? "border border-amber-200 bg-amber-50 text-amber-950"
                : "bg-background text-muted"
          }`}
        >
          {lookupMsg}
        </p>
      ) : null}

      <div>
        <p className="mb-1.5 text-[0.9375rem] font-semibold text-foreground/90">
          Gender (optional)
        </p>
        <SegmentedControl
          value={gender || ""}
          onChange={setGender}
          options={[
            { value: "", label: "—" },
            { value: "M", label: "Male" },
            { value: "F", label: "Female" },
            { value: "O", label: "Other" },
          ]}
          label="Gender"
        />
      </div>

      <Input
        id="patient-address"
        label="Address (optional)"
        error={fieldErrors.address}
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        placeholder="Area / locality"
        enterKeyHint="next"
      />

      <Input
        id="patient-email"
        label="Email (optional)"
        error={fieldErrors.email}
        type="email"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Optional"
      />

      <ErrorBox message={error} />
      {phase === "failed-retryable" && error ? (
        <Button
          type="button"
          variant="secondary"
          disabled={loading}
          loading={loading}
          onClick={retryFailedRegistration}
          className="sm:w-auto"
          data-testid="desk-register-try-again"
        >
          Try Again
        </Button>
      ) : null}
      {likelyDuplicateRegNo != null ? (
        <div
          role="alert"
          className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-3"
        >
          <p className="text-sm font-medium text-amber-950">
            Ye reg #{likelyDuplicateRegNo} jaisa lagta hai — pehle se registered
            hai.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              disabled={loading}
              loading={loading}
              onClick={() => {
                void checkInLikelyDuplicate();
              }}
            >
              Check them in instead
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={loading}
              onClick={() => {
                likelyOverrideOnceRef.current = true;
                formRef.current?.requestSubmit();
              }}
            >
              Register anyway
            </Button>
          </div>
        </div>
      ) : null}
      {aadhaarDuplicateRegNo != null ? (
        <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm text-amber-950">
            Conflict:{" "}
            <span className="font-bold tabular">#{aadhaarDuplicateRegNo}</span>.
            Override aapke account pe record hoga. Next patient pe sticky nahi.
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={loading}
            onClick={() => {
              aadhaarOverrideOnceRef.current = true;
              formRef.current?.requestSubmit();
            }}
          >
            Override — alag person hai
          </Button>
        </div>
      ) : null}

      <div className="sticky-submit">
        <Button
          type="submit"
          disabled={
            loading ||
            lookupState === "loading" ||
            !campDayId ||
            likelyDuplicateRegNo != null
          }
          loading={loading && likelyDuplicateRegNo == null}
          data-testid="desk-register-submit"
          data-phase={phase}
        >
          {loading && likelyDuplicateRegNo == null
            ? "Saving…"
            : "Register karein aur print"}
        </Button>
      </div>
    </form>
  );
}
