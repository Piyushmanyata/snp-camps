"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import {
  digitsOnly,
  formatAadhaarDisplay,
  isAadhaarLookupEnabledClient,
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

/** Recoverable print action after a successful registration (#62). */
type PrintRecovery = {
  patientId: string;
  regNo: number;
  queueStatus?: "registered" | "waiting" | "seen";
  /** True only when the pre-opened target was navigated successfully. */
  printNavigated: boolean;
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
  const lookupEnabled = isAadhaarLookupEnabledClient();

  const [campDayId, setCampDayId] = useState(firstOpen);
  const [aadhaar, setAadhaar] = useState("");
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
  const lookupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLookedUp = useRef("");
  const lookupRequest = useRef(0);
  const registrationAttempt = useRef(
    createRegistrationAttempt(createRequestId),
  );
  const lookupAbort = useRef<AbortController | null>(null);

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

  const runAadhaarLookup = useCallback(
    async (raw: string) => {
      const d = digitsOnly(raw);
      if (!isValidAadhaarNumber(d)) {
        setLookupState("idle");
        setLookupMsg(null);
        return;
      }
      if (lastLookedUp.current === d) return;
      lastLookedUp.current = d;
      const requestId = ++lookupRequest.current;
      lookupAbort.current?.abort();
      const controller = new AbortController();
      lookupAbort.current = controller;

      setLookupState("loading");
      setLookupMsg("Aadhaar se details…");

      try {
        const res = await fetch("/api/aadhaar-lookup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ aadhaar: d }),
          signal: controller.signal,
        });
        const json = (await res.json()) as {
          available?: boolean;
          error?: string;
          profile?: AadhaarProfile;
        };
        if (requestId !== lookupRequest.current) return;

        if (!res.ok) {
          setLookupState(json.available === false ? "skipped" : "fail");
          setLookupMsg(
            json.error || "Aadhaar se nahi mila. Form khud bhariye.",
          );
          return;
        }

        if (json.profile) {
          applyProfile(json.profile);
          setLookupState("ok");
          setLookupMsg("Details bhar gaye — check kar lo.");
        } else {
          setLookupState("fail");
          setLookupMsg("Kuch nahi aaya. Form khud bhariye.");
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (requestId !== lookupRequest.current) return;
        setLookupState("fail");
        setLookupMsg("Aadhaar lookup fail. Naam aur umar khud bhariye.");
      }
    },
    [applyProfile],
  );

  function onAadhaarChange(value: string) {
    const formatted = formatAadhaarDisplay(value);
    setAadhaar(formatted);
    lastLookedUp.current = "";
    lookupRequest.current += 1;
    lookupAbort.current?.abort();

    const d = digitsOnly(formatted);
    if (lookupTimer.current) clearTimeout(lookupTimer.current);

    if (!lookupEnabled || !isStaff) {
      setLookupState("skipped");
      setLookupMsg(
        d.length >= 4 ? "Optional · sirf last 4 store hota hai." : null,
      );
      return;
    }

    if (d.length < 12) {
      setLookupState("idle");
      setLookupMsg(
        d.length > 0 ? "Auto-fill ke liye 12 digit Aadhaar." : null,
      );
      return;
    }

    if (!isValidAadhaarNumber(d)) {
      setLookupState("fail");
      setLookupMsg("Aadhaar galat. Check karo ya khud bhariye.");
      return;
    }

    setLookupState("loading");
    setLookupMsg("Fetching…");
    lookupTimer.current = setTimeout(() => {
      void runAadhaarLookup(d);
    }, 450);
  }

  useEffect(() => {
    return () => {
      if (lookupTimer.current) clearTimeout(lookupTimer.current);
      lookupRequest.current += 1;
      lookupAbort.current?.abort();
    };
  }, []);

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
      setLookupState("idle");
      setLookupMsg(null);
      setFieldErrors({});
      setAadhaarDuplicateRegNo(null);
      setLikelyDuplicateRegNo(null);
      aadhaarOverrideOnceRef.current = false;
      likelyOverrideOnceRef.current = false;
      setCampDayId(firstOpen);
      lastLookedUp.current = "";
      lookupRequest.current += 1;
      lookupAbort.current?.abort();
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
        createdBy,
        campDayId: validated.values.campDayId,
        aadhaarDuplicateOverride,
        likelyDuplicateOverride,
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
      // Retain print recovery BEFORE form reset (#62).
      onSuccess: ({ row, print }) => {
        setPrintRecovery({
          patientId: row.id,
          regNo: row.reg_no,
          queueStatus: row.queue_status,
          printNavigated: print === "navigated",
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
    // User-gesture open — recovery never re-registers.
    window.open(patientPrintPath(printRecovery.patientId), "_blank");
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
    setLookupState("idle");
    setLookupMsg(null);
    setFieldErrors({});
    setCampDayId(firstOpen);
    lastLookedUp.current = "";
    lookupRequest.current += 1;
    lookupAbort.current?.abort();
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
        onChange={(e) => setFullName(e.target.value)}
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
        label={
          lookupEnabled
            ? "Aadhaar (optional · last 4 ya poora)"
            : "Aadhaar last 4 (optional)"
        }
        error={fieldErrors.aadhaar}
        inputMode="numeric"
        autoComplete="off"
        placeholder="XXXX XXXX 1234"
        hint="Poora number kabhi store nahi — sirf last 4"
        value={aadhaar}
        onChange={(e) => onAadhaarChange(e.target.value)}
      />
      {lookupEnabled && digitsOnly(aadhaar).length === 12 ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={lookupState === "loading"}
          onClick={() => {
            lastLookedUp.current = "";
            void runAadhaarLookup(aadhaar);
          }}
        >
          {lookupState === "loading" ? "Fetching…" : "Details lao"}
        </Button>
      ) : null}
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
