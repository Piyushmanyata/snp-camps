"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { digitsOnly, formatAadhaarDisplay } from "@/lib/aadhaar";
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
  isDeskDaySelectable,
  kolkataTodayIso,
  validatePatientForm,
  type PatientFormField,
} from "@/lib/patient-form-validate";
import { checkInPatientWithRetries } from "@/lib/desk-ops";
import { formatCampDay, type CampDayStats } from "@/lib/types";
import {
  Button,
  Input,
  SegmentedControl,
  WarningBox,
} from "@/components/ui";
import { isNonLatinText } from "@/lib/aadhaar-text";
import type { ParsedAadhaarQr } from "@/lib/aadhaar-qr";
import { useAadhaarScanner } from "@/components/use-aadhaar-scanner";
import { AadhaarCapture } from "@/components/aadhaar-capture";
import { AadhaarUsbInput } from "@/components/aadhaar-usb-input";
import { validateHouseholdPhone } from "@/lib/phone";
import { useToastedError } from "@/lib/use-toasted-error";

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
  userRole = null,
}: Props) {
  const todayIso = kolkataTodayIso();
  const openDays = days.filter((d) => isDeskDaySelectable(d, todayIso));
  const firstOpen = openDays[0]?.id || "";

  const [campDayId, setCampDayId] = useState(firstOpen);
  const [aadhaar, setAadhaar] = useState("");
  const [fullName, setFullName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [gender, setGender] = useState("");
  const [age, setAge] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState(defaultPhone);
  const phoneValidation = validateHouseholdPhone(phone);
  const [failedScanAttempts, setFailedScanAttempts] = useState(0);
  const [manualReason, setManualReason] = useState("");
  const [error, setError] = useToastedError(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [aadhaarDuplicateRegNo, setAadhaarDuplicateRegNo] = useState<
    number | null
  >(null);
  const [likelyDuplicateRegNo, setLikelyDuplicateRegNo] = useState<
    number | null
  >(null);
  const [provenance, setProvenance] = useState<
    "self_declared" | "card_scanned"
  >("self_declared");
  const [scannedIdentity, setScannedIdentity] = useState<{
    fullName: string;
    aadhaarLast4: string;
    /** Card DOB — the trusted server route needs the full date. */
    dateOfBirth: string;
  } | null>(null);

  /**
   * Which identity fields the scanned card actually supplied.
   *
   * The lock exists so a scanned value cannot be quietly edited — but a field
   * the card never filled has nothing to protect, and locking it strands the
   * desk. Old XML cards routinely carry no uid (so no last 4) and sometimes no
   * date of birth at all, which left those fields empty, read-only and still
   * marked required: the banner asked the operator to type them in and the form
   * refused the keystrokes. Lock per field, not per scan.
   */
  const [cardProvided, setCardProvided] = useState({
    fullName: false,
    age: false,
    gender: false,
    aadhaarLast4: false,
  });

  const isCardScanned = provenance === "card_scanned" || Boolean(scannedIdentity);
  const isNameLocked = isCardScanned && cardProvided.fullName;
  const isAgeLocked = isCardScanned && cardProvided.age;
  const isGenderLocked = isCardScanned && cardProvided.gender;
  const isAadhaarLocked = isCardScanned && cardProvided.aadhaarLast4;
  const aadhaarOverrideOnceRef = useRef(false);
  const likelyOverrideOnceRef = useRef(false);
  const formRef = useRef<HTMLFormElement | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FormFieldErrors>({});
  const [loading, setLoading] = useState(false);
  /** idle | saving | failed-retryable | registered-print-ready (#62). */
  const [phase, setPhase] = useState<DeskSubmitPhase>("idle");
  /** #107 — which submit button was used; both always visible. */
  const wantPrintRef = useRef(true);
  const [printRecovery, setPrintRecovery] = useState<PrintRecovery | null>(
    null,
  );

  const [lookupState, setLookupState] = useState<LookupState>("idle");
  const [lookupMsg, setLookupMsg] = useState<string | null>(null);
  const registrationAttempt = useRef(
    createRegistrationAttempt(createRequestId),
  );

  const [scannedBanner, setScannedBanner] = useState<string | null>(null);
  // Structure-only fingerprint of the last partial scan (no patient data), so an
  // unsupported card format can be reported from the field.
  const [partialScanDiagnostic, setPartialScanDiagnostic] = useState<string | null>(null);
  /** Amber warning shown when the payload came from an old unsigned legacy XML card. */
  const [legacyQrWarning, setLegacyQrWarning] = useState<string | null>(null);

  /**
   * Fill the form from one decoded card. Returns false to keep the camera
   * running when the payload carried no autofillable field — a partial read on
   * one blurry frame should not end the session when the next may read cleanly.
   */
  const onCardScanned = async (
    parsed: ParsedAadhaarQr,
    diagnostic: string,
  ): Promise<boolean> => {
      const useful =
        Boolean(parsed.fullName) || parsed.age != null || Boolean(parsed.gender);
      if (!useful) return false;

      if (parsed.fullName) {
        setFullName(parsed.fullName);
        if (isNonLatinText(parsed.fullName)) {
          setDisplayName("");
        }
      }
      if (parsed.age != null) setAge(String(parsed.age));
      if (parsed.gender) setGender(parsed.gender);
      if (parsed.address) setAddress(parsed.address);
      if (parsed.aadhaarLast4) setAadhaar(parsed.aadhaarLast4);

      const completeIdentity =
        Boolean(parsed.fullName) &&
        parsed.age != null &&
        Boolean(parsed.gender) &&
        Boolean(parsed.aadhaarLast4) &&
        Boolean(parsed.dateOfBirth);

      if (!completeIdentity) {
        setProvenance("self_declared");
        setScannedIdentity(null);
        setCardProvided({
          fullName: false,
          age: false,
          gender: false,
          aadhaarLast4: false,
        });
        setPartialScanDiagnostic(diagnostic);
        setScannedBanner(
          "Aadhaar scan poora nahi hua. Dobara scan karein. 3 baar fail ho to Team Lead se kahein.",
        );
        return false;
      }

      setProvenance("card_scanned");
      setCardProvided({
        fullName: true,
        age: true,
        gender: true,
        aadhaarLast4: true,
      });
      setScannedIdentity({
        fullName: parsed.fullName!,
        aadhaarLast4: parsed.aadhaarLast4!,
        dateOfBirth: parsed.dateOfBirth!,
      });

      // Legacy XML cards carry no UIDAI signature — show an amber caution badge.
      if (parsed.source === "legacy_xml") {
        setLegacyQrWarning(
          "Purana Aadhaar QR — details bina digital verify ke aayi hain. Card se milaan karein.",
        );
      } else {
        setLegacyQrWarning(null);
      }

      setPartialScanDiagnostic(null);
      setScannedBanner(
        "Aadhaar scan ho gaya — details bhar gayi aur lock ho gayi.",
      );
      return true;
  };

  const scanner = useAadhaarScanner(onCardScanned);
  const { clearError: clearScanError } = scanner;
  // A rejected payload (the app's own desk slip) means nothing was filled.
  const scanDiagnostic = scanner.scanDiagnostic ?? partialScanDiagnostic;
  const lastDiagnostic = useRef<string | null>(null);
  useEffect(() => {
    if (scanDiagnostic && scanDiagnostic !== lastDiagnostic.current) {
      lastDiagnostic.current = scanDiagnostic;
      setFailedScanAttempts((count) => count + 1);
    }
  }, [scanDiagnostic]);

  /**
   * Aadhaar is the source of patient identity, so the typed fields stay out of
   * the way until they are actually needed: either a card was read (and the
   * fields are shown filled and locked, for confirmation) or the operator has
   * explicitly declared the scan a failure.
   *
   * Showing them by default is what makes a desk type a name it could have
   * scanned — slower, and it loses the Aadhaar last-4 and DOB that the
   * duplicate-detection Person key is built from.
   */
  const [manualEntry, setManualEntry] = useState(false);
  const identityVisible = isCardScanned || manualEntry;


  const focusName = useCallback(() => {
    requestAnimationFrame(() => {
      document.getElementById("patient-full-name")?.focus();
    });
  }, []);

  useEffect(() => {
    focusName();
  }, [focusName]);

  function onAadhaarChange(value: string) {
    const formatted = formatAadhaarDisplay(value);
    setAadhaar(formatted);
    const d = digitsOnly(formatted);
    // Only a card that actually asserted a last 4 can be contradicted by typing.
    // Old XML cards often carry no uid, and treating the operator filling that
    // empty field as tampering downgraded a genuine card-scanned record.
    if (
      provenance === "card_scanned" &&
      scannedIdentity &&
      cardProvided.aadhaarLast4 &&
      d !== scannedIdentity.aadhaarLast4
    ) {
      setProvenance("self_declared");
    }
    setLookupState(d.length >= 4 ? "skipped" : "idle");
    setLookupMsg(
      d.length >= 4 ? "Optional · only the last 4 digits are stored." : null,
    );
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
        displayName,
        gender,
        age,
        address,
        phone,
        email: "",
        aadhaar,
      },
      days,
    );

    if (!validated.ok) {
      setPhase("idle");
      failValidation(validated.field, validated.elementId, validated.message);
      return;
    }

    // Register & print: acquire print target during the submit gesture BEFORE
    // any await (#62). Register-only: no window (#107).
    const wantPrint = wantPrintRef.current;
    const printTarget = wantPrint
      ? acquireDeskPrintTarget((url, target, features) =>
          window.open(url, target, features),
        )
      : null;

    const resetFormFields = () => {
      setFullName("");
      setDisplayName("");
      setGender("");
      setAge("");
      setAddress("");
      setPhone(defaultPhone);
      setAadhaar("");
      setProvenance("self_declared");
      setScannedIdentity(null);
    setCardProvided({ fullName: false, age: false, gender: false, aadhaarLast4: false });
      setScannedBanner(null);
      setManualEntry(false);
      setLegacyQrWarning(null);
      setPartialScanDiagnostic(null);
      clearScanError();
      scanner.setConsent(false);
      setFailedScanAttempts(0);
      setManualReason("");
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
        displayName: validated.values.displayName,
        gender: validated.values.gender,
        age: validated.values.age,
        address: validated.values.address,
        phone: validated.values.phone,
        email: null,
        aadhaarLast4: validated.values.aadhaarLast4,
        // The Person key is derived only by the trusted server route.
        duplicateKey: null,
        dateOfBirth: scannedIdentity?.dateOfBirth ?? null,
        createdBy,
        campDayId: validated.values.campDayId,
        aadhaarDuplicateOverride,
        likelyDuplicateOverride,
        provenance,
      },
      rpc: async (fn, args) => {
        if (provenance === "card_scanned") {
          try {
            const response = await fetch("/api/desk/register-scanned", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                requestId: args.p_request_id,
                campId: args.p_camp_id,
                campDayId: args.p_camp_day_id,
                fullName: args.p_full_name,
                displayName: args.p_display_name,
                gender: args.p_gender,
                age: args.p_age,
                address: args.p_address,
                phone: args.p_phone,
                email: args.p_email,
                aadhaarLast4: args.p_aadhaar_last4,
                dateOfBirth: args.p_date_of_birth,
                // Staff one-shot overrides — Person key still server-derived.
                aadhaarDuplicateOverride: Boolean(
                  args.p_aadhaar_duplicate_override,
                ),
                likelyDuplicateOverride: Boolean(
                  args.p_likely_duplicate_override,
                ),
              }),
            });
            const body = (await response.json()) as {
              data?: unknown;
              error?: {
                message?: string;
                code?: string;
                details?: string;
                hint?: string;
              } | null;
            };
            return {
              data: body.data ?? null,
              error: body.error?.message
                ? {
                    message: body.error.message,
                    code: body.error.code,
                    details: body.error.details,
                    hint: body.error.hint,
                  }
                : null,
            };
          } catch {
            return {
              data: null,
              error: {
                message:
                  "Registration service is unavailable. Check your connection and try again.",
                code: "NETWORK_ERROR",
              },
            };
          }
        }
        try {
          const response = await fetch("/api/desk/register-manual", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              requestId: args.p_request_id,
              campId: args.p_camp_id,
              campDayId: args.p_camp_day_id,
              fullName: args.p_full_name,
              displayName: args.p_display_name,
              gender: args.p_gender,
              age: args.p_age,
              address: args.p_address,
              phone: args.p_phone,
              reason: manualReason,
              failedScanAttempts,
            }),
          });
          const body = await response.json();
          return {
            data: body.data ?? null,
            error: body.error?.message
              ? { message: body.error.message, code: String(response.status) }
              : null,
          };
        } catch {
          return {
            data: null,
            error: { message: "Manual registration service is unavailable." },
          };
        }
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
          row.queue_status === "waiting" ? "in the queue" : "registered";
        const flash =
          print === "navigated"
            ? `Reg #${row.reg_no} — ${queueBit}. Print window open.`
            : print === "skipped"
              ? `Reg #${row.reg_no} — ${queueBit}. Print later from the patient list if needed.`
              : `Reg #${row.reg_no} — ${queueBit}. Print blocked — use Print below.`;
        setFlash(flash);
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
        const dupMsg = `Yeh naam aur Aadhaar ke aakhri 4 digit registration #${outcome.aadhaarDuplicateRegNo} ke hain.`;
        setError(dupMsg);
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

  /**
   * Likely-duplicate primary action: queue existing patient + open print path.
   * Flash copy is truth-based — never claims print when the window failed.
   */
  async function printLikelyDuplicateInstead() {
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
      errorContext: "patient-form.print-likely-dup",
      errorFallback: "Could not queue this patient. Try again.",
    });
    if (!outcome.ok) {
      // Preserve likely-duplicate selection + form state for Try Again (#61).
      setError(outcome.error);
      setLoading(false);
      return;
    }
    const row = outcome.row;
    const reg = row.reg_no ?? regTarget;
    const printHref = patientPrintPath(row.id);
    let printOpened = false;
    try {
      const handle = window.open(printHref, "_blank");
      printOpened = Boolean(handle && !handle.closed);
    } catch {
      printOpened = false;
    }
    setPrintRecovery({
      patientId: row.id,
      regNo: reg,
      queueStatus: row.queue_status as "registered" | "waiting" | "seen" | undefined,
      printNavigated: printOpened,
      printHref,
    });
    if (printOpened) {
      setFlash(
        `Registration #${reg} — print window open. No duplicate was created.`,
      );
    } else if (row.already_waiting) {
      setFlash(
        `Registration #${reg} is already in the queue. Print blocked — use Print below. No duplicate was created.`,
      );
    } else {
      setFlash(
        `Registration #${reg} is in the queue. Print blocked — use Print below. No duplicate was created.`,
      );
    }
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
    setAadhaar("");
    setProvenance("self_declared");
    setScannedIdentity(null);
    setCardProvided({ fullName: false, age: false, gender: false, aadhaarLast4: false });
    setLookupState("idle");
    setLookupMsg(null);
    setFieldErrors({});
    setCampDayId(firstOpen);
    focusName();
    setLoading(false);
  }

  function moveDay(currentId: string, direction: -1 | 1) {
    const selectable = days.filter((d) => isDeskDaySelectable(d, todayIso));
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
      <div
        lang="hi-Latn"
        className="space-y-3 rounded-2xl border border-border bg-card p-4"
      >
        <p className="text-sm font-semibold text-foreground">
          Registration sirf camp desk pe
        </p>
        <p className="prose-help text-sm text-muted">
          Volunteer ke paas jao. Staff register karega, parcha print hoga.
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
        No camp days are available. Ask an admin to add them.
      </p>
    );
  }

  if (!openDays.length) {
    return (
      <WarningBox>
        All camp days are full. Wait for seats to open or ask an admin to
        increase the limit.
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
        Desk · sirf naam aur umar zaroori hai
      </div>

      <Input
        id="patient-phone"
        label="Ghar ka mobile number *"
        error={fieldErrors.phone}
        inputMode="numeric"
        autoComplete="tel"
        required
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        placeholder="10 digit mobile"
        hint="Sirf contact ke liye — ghar ke log same number de sakte hain."
      />

      {/* Aadhaar capture stays closed until the household contact is valid. */}
      {phoneValidation.ok ? (
      <div className="rounded-xl border border-brand/20 bg-brand-soft/30 p-3.5 space-y-3">
        <div>
          <p className="text-sm font-semibold text-brand">
            Aadhaar se form bharein
          </p>
          <p className="text-xs text-muted">
            Aadhaar card ka QR scan karein — details apne aap bhar jaayengi. Sirf
            mobile number type karna hai.
          </p>
        </div>

        <AadhaarCapture
          scanner={scanner}
          tone="desk"
          diagnostic={scanDiagnostic}
        />
        <AadhaarUsbInput scanner={scanner} />

        {scannedBanner ? (
          <div
            role="status"
            data-testid="aadhaar-scanned-banner"
            className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2.5 text-xs font-semibold text-blue-950"
          >
            {scannedBanner}
          </div>
        ) : null}

        {legacyQrWarning ? (
          <div
            role="status"
            data-testid="aadhaar-legacy-qr-warning"
            className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs font-semibold text-amber-900"
          >
            &#9888;&#65039; {legacyQrWarning}
          </div>
        ) : null}

        {!identityVisible &&
        failedScanAttempts >= 3 &&
        (userRole === "team_lead" || userRole === "admin") ? (
          <button
            type="button"
            data-testid="desk-manual-entry-escape"
            className="min-h-12 w-full rounded-xl border border-border bg-white px-3 text-sm font-semibold text-brand"
            onClick={() => setManualEntry(true)}
          >
            Team Lead manual entry (audit hoti hai)
          </button>
        ) : null}
        {!identityVisible && failedScanAttempts >= 3 && userRole === "volunteer" ? (
          <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm font-semibold text-amber-950">
            Team Lead ko bulayein — volunteer manual entry nahi kar sakte.
          </p>
        ) : null}
        <p className="text-xs font-semibold text-muted">
          Fail scan: {failedScanAttempts}/3
        </p>
      </div>
      ) : (
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          Pehle sahi mobile number daalein, tab Aadhaar scanner khulega.
        </p>
      )}
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
            Print prescription
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
            const selectable = isDeskDaySelectable(d, todayIso);
            const fullToday =
              d.is_full && d.day_date === todayIso && selectable;
            return (
              <button
                key={d.id}
                id={`camp-day-${d.id}`}
                type="button"
                role="radio"
                aria-checked={active}
                tabIndex={active ? 0 : -1}
                disabled={!selectable}
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
                  d.is_full && !fullToday ? "day-chip-full" : ""
                }`}
              >
                <span className="day-chip-date">
                  {formatCampDay(d.day_date)}
                </span>
                <span className="day-chip-meta">
                  {fullToday
                    ? "FULL · walk-in OK"
                    : d.is_full
                      ? "FULL"
                      : `${d.seats_left} left`}
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
            <option
              key={d.id}
              value={d.id}
              disabled={!isDeskDaySelectable(d, todayIso)}
            >
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

      {identityVisible ? (
        <>
      <Input
        id="patient-full-name"
        label={isNameLocked ? "Full name (Aadhaar locked 🔒) *" : "Full name *"}
        error={fieldErrors.fullName}
        required
        readOnly={isNameLocked}
        aria-readonly={isNameLocked ? true : undefined}
        data-locked={isNameLocked ? "true" : undefined}
        className={isNameLocked ? "bg-slate-100 text-slate-700 font-medium cursor-not-allowed" : ""}
        autoComplete="name"
        autoFocus={!isNameLocked}
        enterKeyHint="next"
        value={fullName}
        onChange={(e) => {
          if (isNameLocked) return;
          const val = e.target.value;
          setFullName(val);
        }}
        placeholder="Patient's full name"
      />

      {isNonLatinText(fullName) ? (
        <Input
          id="patient-display-name"
          label="Latin Display Name / नाम (अंग्रेजी में) *"
          error={fieldErrors.displayName}
          required
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="e.g. Ramesh Kumar"
          hint="Devanagari/non-Latin scanned name requires a Latin display name for printed slips and search."
        />
      ) : null}

      <Input
        id="patient-age"
        label={isAgeLocked ? "Age (Aadhaar locked 🔒) *" : "Age *"}
        error={fieldErrors.age}
        type="number"
        min={0}
        max={149}
        required
        readOnly={isAgeLocked}
        aria-readonly={isAgeLocked ? true : undefined}
        data-locked={isAgeLocked ? "true" : undefined}
        className={isAgeLocked ? "bg-slate-100 text-slate-700 font-medium cursor-not-allowed" : ""}
        inputMode="numeric"
        enterKeyHint="next"
        value={age}
        onChange={(e) => {
          if (isAgeLocked) return;
          setAge(e.target.value);
        }}
        placeholder="Years"
      />
        </>
      ) : null}

      {identityVisible ? (
        <>
      {manualEntry ? (
        <Input
          id="manual-registration-reason"
          label="Manual exception reason *"
          required
          value={manualReason}
          onChange={(e) => setManualReason(e.target.value)}
          placeholder="Why the Aadhaar QR could not be captured"
        />
      ) : null}
      <Input
        id="patient-aadhaar"
        label={isAadhaarLocked ? "Aadhaar last 4 (Aadhaar Locked 🔒)" : "Aadhaar last 4 (optional)"}
        error={fieldErrors.aadhaar}
        inputMode="numeric"
        readOnly={isAadhaarLocked}
        aria-readonly={isAadhaarLocked ? true : undefined}
        data-locked={isAadhaarLocked ? "true" : undefined}
        className={isAadhaarLocked ? "bg-slate-100 text-slate-700 font-medium cursor-not-allowed" : ""}
        autoComplete="off"
        placeholder="XXXX XXXX 1234"
        hint="The full number is never stored — only the last 4 digits"
        value={aadhaar}
        onChange={(e) => {
          if (isAadhaarLocked) return;
          onAadhaarChange(e.target.value);
        }}
      />
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
        <p className="mb-1.5 text-[0.9375rem] font-semibold text-foreground/90 flex items-center gap-1.5">
          Gender (optional){" "}
          {isGenderLocked ? (
            <span className="text-xs font-normal text-amber-700">
              (Aadhaar locked)
            </span>
          ) : null}
        </p>
        {isGenderLocked ? (
          <p
            className="min-h-[3.25rem] rounded-xl border border-border bg-slate-100 px-3.5 py-3 text-[1.0625rem] font-medium text-slate-700"
            data-locked="true"
            aria-readonly="true"
          >
            {gender === "M"
              ? "Male"
              : gender === "F"
                ? "Female"
                : gender === "O"
                  ? "Other"
                  : "—"}
          </p>
        ) : (
          <SegmentedControl
            value={gender || ""}
            onChange={(val) => setGender(val)}
            options={[
              { value: "", label: "—" },
              { value: "M", label: "Male" },
              { value: "F", label: "Female" },
              { value: "O", label: "Other" },
            ]}
            label="Gender"
          />
        )}
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

        </>
      ) : null}

      {error ? (
        <p className="sr-only" role="alert">
          {error}
        </p>
      ) : null}
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
            This looks like registration #{likelyDuplicateRegNo}, which already
            exists.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              disabled={loading}
              loading={loading}
              onClick={() => {
                void printLikelyDuplicateInstead();
              }}
              data-testid="print-likely-duplicate"
            >
              Print for them instead
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
            The override will be recorded against your account and applies only
            to this patient.
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
            Override — different person
          </Button>
        </div>
      ) : null}

      <div className="sticky-submit flex flex-col gap-2 sm:flex-row">
        <Button
          type="submit"
          variant="secondary"
          disabled={
            loading ||
            lookupState === "loading" ||
            !campDayId ||
            !identityVisible ||
            !phoneValidation.ok ||
            (manualEntry && !manualReason.trim()) ||
            likelyDuplicateRegNo != null
          }
          loading={loading && likelyDuplicateRegNo == null}
          data-testid="desk-register-only"
          data-phase={phase}
          onClick={() => {
            wantPrintRef.current = false;
          }}
        >
          {loading && likelyDuplicateRegNo == null ? "Saving…" : "Sirf register"}
        </Button>
        <Button
          type="submit"
          disabled={
            loading ||
            lookupState === "loading" ||
            !campDayId ||
            !identityVisible ||
            !phoneValidation.ok ||
            (manualEntry && !manualReason.trim()) ||
            likelyDuplicateRegNo != null
          }
          loading={loading && likelyDuplicateRegNo == null}
          data-testid="desk-register-submit"
          data-phase={phase}
          onClick={() => {
            wantPrintRef.current = true;
          }}
        >
          {loading && likelyDuplicateRegNo == null
            ? "Saving…"
            : "Register + Print"}
        </Button>
      </div>
    </form>
  );
}
