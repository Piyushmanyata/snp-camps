"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import {
  aadhaarLast4,
  digitsOnly,
  formatAadhaarDisplay,
  isAadhaarLookupEnabledClient,
  isValidAadhaarNumber,
  type AadhaarProfile,
} from "@/lib/aadhaar";
import { normalizePhoneE164 } from "@/lib/phone";
import {
  createRegistrationAttempt,
  submitRegistrationOutbound,
} from "@/lib/registration-request";
import { createRequestId } from "@/lib/request-id";
import { formatCampDay, type CampDayStats } from "@/lib/types";
import {
  Button,
  ErrorBox,
  Input,
  SegmentedControl,
  SuccessBox,
  WarningBox,
} from "@/components/ui";
import { ChangeDay } from "@/components/change-day";

type Props = {
  campId: string;
  days: CampDayStats[];
  defaultPhone?: string;
  userId?: string | null;
  createdBy?: string | null;
  /** Volunteer/admin desk registration — print only, no on-screen QR */
  isStaff?: boolean;
  userRole?: string | null;
};

type Created = {
  id: string;
  reg_no: number;
  full_name: string;
  camp_day_id?: string;
  day_date?: string;
  queue_status?: "registered" | "waiting" | "seen";
  claim_token?: string | null;
  notifyNote?: string;
  phone?: string | null;
};

type LookupState = "idle" | "loading" | "ok" | "fail" | "skipped";
type FormField =
  | "campDay"
  | "aadhaar"
  | "fullName"
  | "phone"
  | "age"
  | "address"
  | "email";
type FormFieldErrors = Partial<Record<FormField, string>>;

export function PatientForm({
  campId,
  days,
  defaultPhone = "",
  userId = null,
  createdBy = null,
  isStaff = false,
  userRole = null,
}: Props) {
  const optionalDetailsId = `patient-optional-details-${useId().replace(/:/g, "")}`;
  const openDays = useMemo(() => days.filter((d) => !d.is_full), [days]);
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
  /** Staff-only: conflicting reg no when Aadhaar last-4 + name collides. */
  const [aadhaarDuplicateRegNo, setAadhaarDuplicateRegNo] = useState<
    number | null
  >(null);
  /** One-shot; never sticky across walk-ins. */
  const aadhaarOverrideOnceRef = useRef(false);
  const formRef = useRef<HTMLFormElement | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FormFieldErrors>({});
  const [loading, setLoading] = useState(false);

  function failValidation(
    field: FormField,
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

  const [created, setCreated] = useState<Created | null>(null);
  const [queueNote, setQueueNote] = useState<string | null>(null);

  const [lookupState, setLookupState] = useState<LookupState>("idle");
  const [lookupMsg, setLookupMsg] = useState<string | null>(null);
  const [filledFromAadhaar, setFilledFromAadhaar] = useState(false);
  const [showAadhaarLater, setShowAadhaarLater] = useState(false);
  const lookupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLookedUp = useRef<string>("");
  const lookupRequest = useRef(0);
  /** Stable idempotency key for the in-flight registration attempt (retries reuse it). */
  const registrationAttempt = useRef(createRegistrationAttempt(createRequestId));
  const lookupAbort = useRef<AbortController | null>(null);

  const applyProfile = useCallback((profile: AadhaarProfile) => {
    if (profile.full_name) setFullName(profile.full_name);
    if (profile.gender) setGender(profile.gender);
    if (profile.age != null) setAge(String(profile.age));
    if (profile.address) setAddress(profile.address);
    if (profile.phone) setPhone(profile.phone);
    if (profile.email) setEmail(profile.email);
    setFilledFromAadhaar(true);
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
      setLookupMsg("Fetching details from Aadhaar…");
      setError(null);

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
            json.error ||
              "Could not fetch Aadhaar details. Fill the form manually.",
          );
          setFilledFromAadhaar(false);
          return;
        }

        if (json.profile) {
          applyProfile(json.profile);
          setLookupState("ok");
          setLookupMsg(
            "Details filled from Aadhaar — edit if anything is wrong.",
          );
        } else {
          setLookupState("fail");
          setLookupMsg("No details returned. Fill the form manually.");
          setFilledFromAadhaar(false);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (requestId !== lookupRequest.current) return;
        setLookupState("fail");
        setLookupMsg(
          "Aadhaar lookup failed. Fill name, age and address manually below.",
        );
        setFilledFromAadhaar(false);
      }
    },
    [applyProfile],
  );

  function onAadhaarChange(value: string) {
    const formatted = formatAadhaarDisplay(value);
    setAadhaar(formatted);
    setFilledFromAadhaar(false);
    lastLookedUp.current = "";
    lookupRequest.current += 1;
    lookupAbort.current?.abort();

    const d = digitsOnly(formatted);
    if (lookupTimer.current) clearTimeout(lookupTimer.current);

    if (!lookupEnabled || !isStaff) {
      setLookupState("skipped");
      setLookupMsg(
        d.length >= 4
          ? "Optional · only last 4 digits are stored when provided."
          : null,
      );
      return;
    }

    if (d.length < 12) {
      setLookupState("idle");
      setLookupMsg(
        d.length > 0 ? "Enter full 12-digit Aadhaar to auto-fill." : null,
      );
      return;
    }

    if (!isValidAadhaarNumber(d)) {
      setLookupState("fail");
      setLookupMsg(
        "Invalid Aadhaar number. Check digits or enter details manually.",
      );
      return;
    }

    setLookupState("loading");
    setLookupMsg("Fetching details…");
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

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isStaff) return;

    setLoading(true);
    setError(null);
    setFieldErrors({});
    setQueueNote(null);
    const aadhaarDuplicateOverride = aadhaarOverrideOnceRef.current;
    aadhaarOverrideOnceRef.current = false;
    if (!aadhaarDuplicateOverride) {
      setAadhaarDuplicateRegNo(null);
    }

    if (!campDayId) {
      failValidation(
        "campDay",
        `camp-day-${firstOpen}`,
        "Select a camp day with open seats.",
      );
      return;
    }

    const selected = days.find((d) => d.id === campDayId);
    if (selected?.is_full) {
      failValidation(
        "campDay",
        `camp-day-${campDayId}`,
        "That day is full. Choose another day.",
      );
      return;
    }

    const aDigits = digitsOnly(aadhaar);
    const last4 = aadhaarLast4(aadhaar);

    if (aadhaar.trim()) {
      if (aDigits.length === 12 && !isValidAadhaarNumber(aDigits)) {
        setShowAadhaarLater(true);
        failValidation(
          "aadhaar",
          "patient-aadhaar",
          "Aadhaar number looks invalid. Correct it or clear the field.",
        );
        return;
      }
      if (aDigits.length > 0 && aDigits.length < 4) {
        setShowAadhaarLater(true);
        failValidation(
          "aadhaar",
          "patient-aadhaar",
          "Aadhaar: enter full 12 digits or last 4 only.",
        );
        return;
      }
      if (last4.length !== 4 && aDigits.length > 0) {
        setShowAadhaarLater(true);
        failValidation(
          "aadhaar",
          "patient-aadhaar",
          "Aadhaar: enter full number or last 4 digits (only last 4 is stored).",
        );
        return;
      }
    }

    if (!fullName.trim()) {
      failValidation("fullName", "patient-full-name", "Full name is required.");
      return;
    }

    const phoneRaw = phone.trim();
    const normalizedPhone = phoneRaw ? normalizePhoneE164(phoneRaw) : null;
    const phone10 = normalizedPhone?.slice(-10) || "";

    if (phoneRaw && !normalizedPhone) {
      failValidation(
        "phone",
        "patient-phone",
        "Phone must be a valid 10-digit Indian mobile, or leave blank.",
      );
      return;
    }

    const ageValue = age === "" ? null : Number(age);
    if (
      ageValue === null ||
      !Number.isInteger(ageValue) ||
      ageValue < 0 ||
      ageValue >= 150
    ) {
      failValidation(
        "age",
        "patient-age",
        "Age is required (whole number from 0 to 149).",
      );
      return;
    }

    if (!address.trim()) {
      failValidation("address", "patient-address", "Address is required.");
      return;
    }

    if (email.trim() && !/^[^\s@]+@[^\s@]+$/.test(email.trim())) {
      setShowAadhaarLater(true);
      failValidation(
        "email",
        "patient-email",
        "Enter a valid email address or leave it blank.",
      );
      return;
    }

    const supabase = createClient();
    const {
      data,
      error: registrationError,
      aadhaarDuplicateRegNo: dupReg,
    } = await submitRegistrationOutbound({
      isStaff: true,
      attempt: registrationAttempt.current,
      staffFields: {
        campId,
        fullName: fullName.trim(),
        gender: gender || null,
        age: ageValue,
        address: address.trim() || null,
        phone: phone10 || null,
        email: email.trim() || null,
        aadhaarLast4: last4 || null,
        userId,
        createdBy,
        campDayId,
        aadhaarDuplicateOverride,
      },
      rpc: async (fn, args) => {
        const result = await supabase.rpc(fn, args);
        return {
          data: result.data,
          error: result.error ? { message: result.error.message } : null,
        };
      },
    });

    if (registrationError) {
      if (dupReg) {
        setAadhaarDuplicateRegNo(dupReg);
        setError(
          `Name and Aadhaar last-4 match existing reg no ${dupReg}. Look that patient up first. Override only if this is a different person.`,
        );
      } else {
        setAadhaarDuplicateRegNo(null);
        setError(registrationError);
      }
      setLoading(false);
      return;
    }
    setAadhaarDuplicateRegNo(null);

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      setError("Registration failed — no row returned.");
      setLoading(false);
      return;
    }

    // Success: rotate idempotency key so the next walk-in is a new request.
    registrationAttempt.current.rotate();

    const base = row as Created;
    const inQueue = base.queue_status === "waiting";
    setCreated({
      ...base,
      notifyNote: phone10
        ? "Registered. Status is passwordless — an SMS status link can be sent when configured."
        : "Registered. No phone on file — status is passwordless via desk reprint / SMS when configured.",
    });
    setQueueNote(
      inQueue
        ? `Reg #${base.reg_no} checked in — in the FCFS queue. Print a desk slip if needed.`
        : `Reg #${base.reg_no} pre-registered (not in queue). Check them in when they arrive, or print a slip for later.`,
    );
    setLoading(false);
  }

  function resetForm() {
    setCreated(null);
    setQueueNote(null);
    setError(null);
    setAadhaarDuplicateRegNo(null);
    aadhaarOverrideOnceRef.current = false;
    setFullName("");
    setGender("");
    setAge("");
    setAddress("");
    setPhone(defaultPhone);
    setEmail("");
    setAadhaar("");
    setLookupState("idle");
    setLookupMsg(null);
    setFilledFromAadhaar(false);
    setCampDayId(firstOpen);
    lastLookedUp.current = "";
    lookupRequest.current += 1;
    lookupAbort.current?.abort();
    registrationAttempt.current.rotate();
  }

  function moveDay(currentId: string, direction: -1 | 1) {
    const selectable = days.filter((d) => !d.is_full);
    const currentIndex = selectable.findIndex((d) => d.id === currentId);
    if (currentIndex < 0 || selectable.length < 2) return;
    const next =
      selectable[(currentIndex + direction + selectable.length) % selectable.length];
    setCampDayId(next.id);
    window.setTimeout(() => {
      document.getElementById(`camp-day-${next.id}`)?.focus();
    }, 0);
  }

  if (!isStaff) {
    return (
      <div className="space-y-3 rounded-2xl border border-border bg-card p-4">
        <p className="text-sm font-semibold text-foreground">
          Registration is at the camp desk only
        </p>
        <p className="prose-help text-sm text-muted">
          Walk up to a volunteer. Staff register you, print a desk slip with a
          staff-scan QR, and can share a passwordless status link by SMS later.
          There is no public online registration or patient login.
        </p>
        <Link
          href="/"
          className="pressable inline-flex min-h-11 items-center justify-center rounded-xl border border-border bg-white px-4 text-sm font-semibold text-brand hover:bg-brand-soft"
        >
          Back to home
        </Link>
      </div>
    );
  }

  if (created) {
    const inQueue = created.queue_status === "waiting";
    return (
      <div className="space-y-4">
        <div className="rounded-2xl border border-brand/20 bg-brand-soft px-4 py-4 text-center">
          <p className="text-sm font-semibold text-brand">
            {inQueue ? "Registered & in queue" : "Pre-registered"}
          </p>
          <p
            className="tabular mt-1 text-4xl font-bold tracking-tight text-brand"
            translate="no"
          >
            #{created.reg_no}
          </p>
          <p className="mt-1 text-lg font-bold text-foreground">
            {created.full_name}
          </p>
          <p className="mt-1 text-xs text-brand/80">
            {created.day_date
              ? `Day: ${formatCampDay(created.day_date)} · `
              : ""}
            {inQueue
              ? "Walk-in — already checked in to the FCFS queue"
              : "Not in queue until check-in on camp day"}
          </p>
        </div>

        <div className="space-y-3 rounded-xl border border-border bg-card p-3.5 sm:rounded-2xl sm:p-4">
          {queueNote ? <SuccessBox message={queueNote} /> : null}
          {created.notifyNote ? (
            <p className="text-xs text-muted">{created.notifyNote}</p>
          ) : null}
          <div>
            <p className="text-sm font-semibold text-foreground">
              Print desk slip
            </p>
            <p className="prose-help mt-0.5 text-xs text-muted">
              The slip carries the staff-scan QR. Printing can also check them
              into the queue if they are still only pre-registered. Patient
              status is passwordless (SMS link later).
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Link
              href={`/print/${created.id}?auto=1`}
              className="pressable inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-brand px-4 text-[1.0625rem] font-semibold text-white transition-colors hover:bg-brand-dark"
            >
              {inQueue ? "Print desk slip" : "Print desk slip (check-in)"}
            </Link>
            <Button type="button" variant="secondary" onClick={resetForm}>
              Register another patient
            </Button>
          </div>
          <ErrorBox message={error} />
        </div>

        <div className="rounded-xl border border-border p-4">
          <p className="mb-2 text-sm font-medium">Need a different day?</p>
          <ChangeDay
            patientId={created.id}
            currentDayId={created.camp_day_id || campDayId}
            days={days}
            queueStatus={created.queue_status || "registered"}
            onDayChanged={(newDayId, newDayDate) => {
              setCreated((prev) =>
                prev
                  ? {
                      ...prev,
                      camp_day_id: newDayId,
                      day_date: newDayDate || prev.day_date,
                    }
                  : null,
              );
            }}
          />
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Link
            href={
              userRole === "admin"
                ? "/admin"
                : userRole === "doctor"
                  ? "/doctor"
                  : "/volunteer"
            }
            className="pressable inline-flex min-h-12 w-full items-center justify-center rounded-xl border border-border bg-white px-4 text-sm font-semibold text-brand hover:bg-brand-soft sm:flex-1"
          >
            {userRole === "admin"
              ? "Back to admin"
              : userRole === "doctor"
                ? "Back to doctor desk"
                : "Back to volunteer desk"}
          </Link>
        </div>
      </div>
    );
  }

  if (!days.length) {
    return (
      <p className="text-sm text-muted">
        No camp days configured. Ask admin to add days and seat limits.
      </p>
    );
  }

  if (!openDays.length) {
    return (
      <WarningBox>
        All days are full. You can still view seat status on the home page —
        registration reopens if seats free up or admin raises limits.
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
        Desk mode — phone optional; age &amp; address required
      </div>

      {/* Tap chips — faster than select on outdoor phones */}
      <div>
        <p className="mb-1.5 text-[0.9375rem] font-semibold text-foreground/90">
          Camp day *
        </p>
        <div
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
        {/* Hidden native select keeps form semantics + fallback */}
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
        label="Full name *"
        error={fieldErrors.fullName}
        required
        autoComplete="name"
        autoFocus
        enterKeyHint="next"
        value={fullName}
        onChange={(e) => setFullName(e.target.value)}
        placeholder="Patient full name"
      />
      <Input
        id="patient-phone"
        label="Phone (optional)"
        error={fieldErrors.phone}
        inputMode="tel"
        autoComplete="tel"
        enterKeyHint="next"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        placeholder="10-digit mobile (optional)"
        hint="Optional — used for status SMS when configured"
      />

      <div>
        <p className="mb-1.5 text-[0.9375rem] font-semibold text-foreground/90">
          Gender
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

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input
          id="patient-age"
          label="Age *"
          error={fieldErrors.age}
          type="number"
          min={0}
          max={149}
          required
          inputMode="numeric"
          enterKeyHint="next"
          value={age}
          onChange={(e) => setAge(e.target.value)}
          placeholder="Years"
        />
        <Input
          id="patient-address"
          label="Address *"
          error={fieldErrors.address}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Area / locality"
          enterKeyHint="next"
          required
        />
      </div>

      {/* Optional extras collapsed for speed */}
      <div className="rounded-xl border border-dashed border-border bg-background/80 sm:rounded-2xl">
        <button
          type="button"
          aria-expanded={showAadhaarLater}
          aria-controls={optionalDetailsId}
          className="flex min-h-12 w-full items-center justify-between gap-2 px-3.5 py-2.5 text-left sm:px-4 sm:py-3"
          onClick={() => setShowAadhaarLater((v) => !v)}
        >
          <div>
            <p className="text-sm font-semibold text-foreground">
              Optional details
            </p>
            <p className="text-xs text-muted">
              Email · Aadhaar last 4 · auto-fill
            </p>
          </div>
          <span className="text-muted" aria-hidden="true">
            {showAadhaarLater ? "▴" : "▾"}
          </span>
        </button>
        {showAadhaarLater ? (
          <div
            id={optionalDetailsId}
            className="space-y-3 border-t border-border px-3.5 pb-3.5 pt-3 sm:px-4 sm:pb-4"
          >
            <Input
              id="patient-email"
              label="Email"
              error={fieldErrors.email}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Optional"
            />
            <Input
              id="patient-aadhaar"
              label={lookupEnabled ? "Aadhaar number" : "Aadhaar (optional)"}
              error={fieldErrors.aadhaar}
              inputMode="numeric"
              autoComplete="off"
              placeholder="XXXX XXXX 1234"
              hint="Never stored in full — last 4 only"
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
                {lookupState === "loading" ? "Fetching…" : "Fetch details"}
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
            {filledFromAadhaar ? (
              <p className="text-xs text-brand">
                Some fields filled from Aadhaar — review before save.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <p className="rounded-xl border border-border bg-background px-3 py-2.5 text-xs text-muted">
        After save they stay registered. Print to join the queue, or a doctor
        can scan them directly (seen). Status is passwordless — no patient
        login.
      </p>
      <ErrorBox message={error} />
      {aadhaarDuplicateRegNo != null ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 space-y-2">
          <p className="text-sm text-amber-950">
            Conflicting registration:{" "}
            <span className="font-bold tabular">#{aadhaarDuplicateRegNo}</span>.
            Override is recorded against the new registration with your staff
            account and the current time. Not sticky for the next walk-in.
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
            Override and register as different person
          </Button>
        </div>
      ) : null}
      <div className="sticky-submit">
        <Button
          type="submit"
          disabled={loading || lookupState === "loading" || !campDayId}
          loading={loading}
        >
          {loading ? "Saving…" : "Save registration"}
        </Button>
      </div>
    </form>
  );
}
