"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
import { formatCampDay, type CampDayStats } from "@/lib/types";
import {
  Button,
  ErrorBox,
  Input,
  SegmentedControl,
  SuccessBox,
  WarningBox,
} from "@/components/ui";
import { Toast } from "@/components/toast";
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
  claim_token?: string | null;
  password?: string;
  loggedIn?: boolean;
  notifyNote?: string;
};

type LookupState = "idle" | "loading" | "ok" | "fail" | "skipped";

export function PatientForm({
  campId,
  days,
  defaultPhone = "",
  userId = null,
  createdBy = null,
  isStaff = false,
  userRole = null,
}: Props) {
  const router = useRouter();
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
  const [loading, setLoading] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const [queueNote, setQueueNote] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  // Self-reg: phone OTP gate (primary). Aadhaar kept for later.
  const [otpStep, setOtpStep] = useState<"phone" | "otp" | "form">(
    isStaff ? "form" : "phone",
  );
  const [otp, setOtp] = useState("");
  const [phoneVerified, setPhoneVerified] = useState(isStaff);
  const [sessionUserId, setSessionUserId] = useState<string | null>(userId);

  const [lookupState, setLookupState] = useState<LookupState>("idle");
  const [lookupMsg, setLookupMsg] = useState<string | null>(null);
  const [filledFromAadhaar, setFilledFromAadhaar] = useState(false);
  const [showAadhaarLater, setShowAadhaarLater] = useState(false);
  const lookupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLookedUp = useRef<string>("");
  const lookupRequest = useRef(0);
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

  async function sendOtp(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const phoneE164 = normalizePhoneE164(phone);
    if (!phoneE164) {
      setError("Enter a valid 10-digit Indian mobile number.");
      setLoading(false);
      return;
    }
    const supabase = createClient();
    const { error: err } = await supabase.auth.signInWithOtp({
      phone: phoneE164,
    });
    if (err) {
      setError(
        err.message +
          " — Phone OTP needs SMS configured in Supabase Auth. Ask the desk to register you if SMS is unavailable.",
      );
      setLoading(false);
      return;
    }
    setOtpStep("otp");
    setLoading(false);
  }

  async function verifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const phoneE164 = normalizePhoneE164(phone);
    if (!phoneE164) {
      setError("Enter a valid 10-digit Indian mobile number.");
      setLoading(false);
      return;
    }
    const supabase = createClient();
    const { error: err } = await supabase.auth.verifyOtp({
      phone: phoneE164,
      token: otp,
      type: "sms",
    });
    if (err) {
      setError(err.message);
      setLoading(false);
      return;
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setError("OTP verified but no session was created. Try again.");
      setLoading(false);
      return;
    }

    const { error: profileError } = await supabase
      .from("profiles")
      .update({ role: "patient", phone: phoneE164 })
      .eq("id", user.id);
    if (profileError) {
      setError("Could not save your patient profile. Try again.");
      setLoading(false);
      return;
    }

    // If desk already registered this phone, link and open profile
    const { data: linkedId, error: linkErr } = await supabase.rpc(
      "link_patient_phone",
      { p_phone: phoneE164 },
    );
    if (!linkErr && linkedId) {
      router.replace("/patient");
      return;
    }

    setSessionUserId(user.id);
    setPhoneVerified(true);
    setOtpStep("form");
    setPhone(phoneE164.replace(/\D/g, "").slice(-10));
    setLoading(false);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setQueueNote(null);

    if (!campDayId) {
      setError("Select a camp day with open seats.");
      setLoading(false);
      return;
    }

    const selected = days.find((d) => d.id === campDayId);
    if (selected?.is_full) {
      setError("That day is full. Choose another day.");
      setLoading(false);
      return;
    }

    const aDigits = digitsOnly(aadhaar);
    const last4 = aadhaarLast4(aadhaar);

    if (aadhaar.trim()) {
      if (aDigits.length === 12 && !isValidAadhaarNumber(aDigits)) {
        setError("Aadhaar number looks invalid. Correct it or clear the field.");
        setLoading(false);
        return;
      }
      if (aDigits.length > 0 && aDigits.length < 4) {
        setError("Aadhaar: enter full 12 digits or last 4 only.");
        setLoading(false);
        return;
      }
      if (last4.length !== 4 && aDigits.length > 0) {
        setError(
          "Aadhaar: enter full number or last 4 digits (only last 4 is stored).",
        );
        setLoading(false);
        return;
      }
    }

    if (!fullName.trim()) {
      setError("Full name is required.");
      setLoading(false);
      return;
    }

    const phoneRaw = phone.trim();
    const normalizedPhone = phoneRaw ? normalizePhoneE164(phoneRaw) : null;
    const phone10 = normalizedPhone?.slice(-10) || "";

    if (isStaff) {
      // Desk: phone optional; if provided must be valid
      if (phoneRaw && !normalizedPhone) {
        setError("Phone must be a valid 10-digit Indian mobile, or leave blank.");
        setLoading(false);
        return;
      }
    } else {
      if (!normalizedPhone) {
        setError("Phone is required (10-digit mobile).");
        setLoading(false);
        return;
      }
      if (!phoneVerified) {
        setError("Verify your phone with OTP first.");
        setLoading(false);
        return;
      }
    }

    const ageValue = age === "" ? null : Number(age);
    if (
      ageValue === null ||
      !Number.isInteger(ageValue) ||
      ageValue < 0 ||
      ageValue >= 150
    ) {
      setError("Age is required (whole number from 0 to 149).");
      setLoading(false);
      return;
    }

    if (!address.trim()) {
      setError("Address is required.");
      setLoading(false);
      return;
    }

    const supabase = createClient();
    let data: unknown;
    let registrationError: string | null = null;

    if (isStaff) {
      const result = await supabase.rpc("register_patient", {
        p_camp_id: campId,
        p_full_name: fullName.trim(),
        p_gender: gender || null,
        p_age: ageValue,
        p_address: address.trim() || null,
        p_phone: phone10 || null,
        p_email: email.trim() || null,
        p_aadhaar_last4: last4 || null,
        p_user_id: userId,
        p_created_by: createdBy,
        p_camp_day_id: campDayId,
      });
      data = result.data;
      registrationError = result.error?.message || null;
    } else {
      try {
        const response = await fetch("/api/patient-register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            campId,
            campDayId,
            fullName: fullName.trim(),
            gender: gender || null,
            age: ageValue,
            address: address.trim() || null,
            phone: phone10,
            email: email.trim() || null,
            aadhaarLast4: last4 || null,
          }),
        });
        const payload = (await response.json()) as {
          patient?: Created;
          error?: string;
        };
        data = payload.patient;
        registrationError = response.ok
          ? null
          : payload.error || "Registration failed";
      } catch {
        registrationError =
          "Registration service is unavailable. Check your connection and try again.";
      }
    }

    if (registrationError) {
      setError(registrationError);
      setLoading(false);
      return;
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      setError("Registration failed — no row returned.");
      setLoading(false);
      return;
    }

    const base = row as Created;

    if (isStaff) {
      setCreated(base);
      setQueueNote(
        "Registered only. Print prescription to put them in the queue (optional if doctor will scan).",
      );
      setLoading(false);
      return;
    }

    // Phone OTP self-reg: already signed in — optional password fallback
    try {
      const accRes = await fetch("/api/patient-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientId: base.id,
          regNo: base.reg_no,
          claimToken: base.claim_token,
          returnCredentials: true,
          notify: true,
        }),
      });
      const acc = (await accRes.json().catch(() => ({}))) as {
        error?: string;
        password?: string;
        notify?: { sms?: string; whatsapp?: string };
        notifyConfigured?: { sms?: boolean; whatsapp?: boolean };
        message?: string;
      };

      if (!accRes.ok) {
        setCreated({
          ...base,
          loggedIn: true,
          notifyNote:
            acc.error ||
            "Registered and signed in. Backup password could not be issued; use phone OTP.",
        });
        setLoading(false);
        return;
      }

      const smsOn = acc.notifyConfigured?.sms;
      const waOn = acc.notifyConfigured?.whatsapp;
      let notifyNote =
        "You are signed in with phone OTP. Save reg no + password as backup when shown.";
      if (acc.notify) {
        const parts: string[] = [];
        if (acc.notify.sms === "sent") parts.push("SMS sent");
        else if (smsOn && acc.notify.sms === "failed") parts.push("SMS failed");
        else if (!smsOn) parts.push("SMS not configured yet");
        if (acc.notify.whatsapp === "sent") parts.push("WhatsApp sent");
        else if (waOn && acc.notify.whatsapp === "failed")
          parts.push("WhatsApp failed");
        else if (!waOn) parts.push("WhatsApp not configured yet");
        if (parts.length) notifyNote = parts.join(" · ");
      }

      setCreated({
        ...base,
        password: acc.password,
        loggedIn: true,
        notifyNote,
      });
      router.refresh();
    } catch {
      setCreated({ ...base, loggedIn: true });
    }
    setLoading(false);
  }

  function resetForm() {
    setCreated(null);
    setQueueNote(null);
    setError(null);
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
    if (!isStaff) {
      setOtpStep("phone");
      setOtp("");
      setPhoneVerified(false);
      setSessionUserId(null);
    }
    lastLookedUp.current = "";
    lookupRequest.current += 1;
    lookupAbort.current?.abort();
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

  if (created) {
    return (
      <div className="space-y-4">
        <div className="rounded-2xl border border-brand/20 bg-brand-soft px-4 py-4 text-center">
          <p className="text-sm font-semibold text-brand">
            {created.loggedIn ? "Registered & signed in" : "Registered"}
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
            {isStaff
              ? "Registered at desk — print to join queue, or doctor can scan directly"
              : "You are logged in with phone OTP"}
          </p>
        </div>

        {!isStaff && created.password ? (
          <div className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4">
            <p className="text-sm font-bold text-amber-950">
              Backup login (optional)
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-xl bg-white px-3 py-2 ring-1 ring-amber-200/80">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                  Reg number
                </p>
                <p className="tabular text-2xl font-bold text-brand" translate="no">
                  #{created.reg_no}
                </p>
              </div>
              <div className="rounded-xl bg-white px-3 py-2 ring-1 ring-amber-200/80">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                  Password
                </p>
                <p
                  className="font-mono text-2xl font-bold tracking-wider text-foreground"
                  translate="no"
                >
                  {created.password}
                </p>
              </div>
            </div>
            <p className="text-xs text-amber-900/90">
              {created.notifyNote ||
                "Prefer phone OTP next time. Password is a backup."}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Link
                href="/patient"
                className="pressable inline-flex min-h-12 flex-1 items-center justify-center rounded-xl bg-brand px-4 text-sm font-semibold text-white shadow-sm hover:bg-brand-dark"
              >
                Go to my profile
              </Link>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard?.writeText(
                    `Reg #${created.reg_no}\nPassword: ${created.password}`,
                  );
                  setToastMsg("Credentials copied to clipboard");
                }}
              >
                Copy login
              </Button>
            </div>
            {toastMsg ? (
              <Toast message={toastMsg} onClose={() => setToastMsg(null)} />
            ) : null}
          </div>
        ) : !isStaff ? (
          <Link
            href="/patient"
            className="pressable inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-brand px-4 text-sm font-semibold text-white shadow-sm hover:bg-brand-dark"
          >
            Go to my profile
          </Link>
        ) : null}

        {isStaff ? (
          <div className="space-y-3 rounded-xl border border-border bg-card p-3.5 shadow-sm sm:rounded-2xl sm:p-4">
            {queueNote ? <SuccessBox message={queueNote} /> : null}
            <div>
              <p className="text-sm font-semibold text-foreground">
                Print prescription (optional)
              </p>
              <p className="prose-help mt-0.5 text-xs text-muted">
                Print puts them in the FCFS queue. Doctors can also scan a
                registered patient directly without printing.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Link
                href={`/print/${created.id}?auto=1`}
                className="pressable inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-brand px-4 text-[1.0625rem] font-semibold text-white shadow-sm transition-colors hover:bg-brand-dark"
              >
                Print now (join queue)
              </Link>
              <Button type="button" variant="secondary" onClick={resetForm}>
                Register another walk-in
              </Button>
            </div>
            <ErrorBox message={error} />
          </div>
        ) : null}

        <div className="rounded-xl border border-border p-4">
          <p className="mb-2 text-sm font-medium">Need a different day?</p>
          <ChangeDay
            patientId={created.id}
            currentDayId={created.camp_day_id || campDayId}
            days={days}
            queueStatus="registered"
          />
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          {isStaff ? (
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
          ) : (
            <Link
              href="/patient"
              className="pressable inline-flex min-h-12 flex-1 items-center justify-center rounded-xl border border-border bg-white px-4 text-sm font-semibold text-brand hover:bg-brand-soft"
            >
              My profile
            </Link>
          )}
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

  // —— Self-reg: phone OTP steps ——
  if (!isStaff && otpStep === "phone") {
    return (
      <form onSubmit={sendOtp} className="space-y-4" noValidate>
        <div className="rounded-2xl border border-brand/20 bg-brand-soft/40 p-4">
          <p className="text-sm font-semibold text-foreground">
            Step 1 · Verify mobile
          </p>
          <p className="mt-1 text-xs text-muted">
            Main registration is phone OTP. Aadhaar integration is reserved for
            later.
          </p>
        </div>
        <Input
          label="Mobile number *"
          inputMode="tel"
          autoComplete="tel"
          required
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="10-digit Indian mobile"
          hint="OTP sent by SMS (Supabase Auth)"
        />
        <ErrorBox message={error} />
        <Button type="submit" loading={loading} disabled={loading}>
          {loading ? "Sending OTP…" : "Send OTP"}
        </Button>
      </form>
    );
  }

  if (!isStaff && otpStep === "otp") {
    return (
      <form onSubmit={verifyOtp} className="space-y-4" noValidate>
        <div className="rounded-2xl border border-brand/20 bg-brand-soft/40 p-4">
          <p className="text-sm font-semibold text-foreground">
            Step 2 · Enter OTP
          </p>
          <p className="mt-1 text-xs text-muted">
            Code sent to{" "}
            <span className="font-semibold text-foreground" translate="no">
              {normalizePhoneE164(phone) || phone}
            </span>
          </p>
        </div>
        <Input
          label="OTP *"
          name="otp"
          inputMode="numeric"
          autoComplete="one-time-code"
          required
          value={otp}
          onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 8))}
          placeholder="6-digit code"
        />
        <ErrorBox message={error} />
        <Button type="submit" loading={loading} disabled={loading}>
          {loading ? "Verifying…" : "Verify & continue"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setOtpStep("phone");
            setOtp("");
            setError(null);
          }}
        >
          Change number
        </Button>
      </form>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3.5 sm:space-y-4">
      {!isStaff ? (
        <div className="rounded-xl border border-green-200 bg-green-50 px-3.5 py-2.5 text-sm text-brand">
          Phone verified
          {sessionUserId ? " · signed in" : ""} · complete your details
        </div>
      ) : (
        <div className="rounded-xl border border-brand/15 bg-brand-soft/50 px-3.5 py-2.5 text-sm text-brand">
          Desk mode — no OTP — phone optional; age & address required
        </div>
      )}

      {/* Tap chips — faster than select on outdoor phones */}
      <div>
        <p className="mb-1.5 text-[0.9375rem] font-semibold text-foreground/90">
          Camp day *
        </p>
        <div
          className="day-chip-row"
          role="radiogroup"
          aria-label="Camp day"
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
                  } else if (
                    e.key === "ArrowLeft" ||
                    e.key === "ArrowUp"
                  ) {
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
      </div>

      {/* Critical fields first on phone: name + phone */}
      <Input
        label="Full name *"
        required
        autoComplete="name"
        autoFocus={isStaff}
        enterKeyHint="next"
        value={fullName}
        onChange={(e) => setFullName(e.target.value)}
        placeholder="Patient full name"
      />
            <Input
        label={isStaff ? "Phone (optional)" : "Phone *"}
        inputMode="tel"
        autoComplete="tel"
        required={!isStaff}
        enterKeyHint="next"
        value={phone}
        onChange={(e) => {
          if (!isStaff && phoneVerified) return;
          setPhone(e.target.value);
        }}
        readOnly={!isStaff && phoneVerified}
        placeholder={isStaff ? "10-digit mobile (optional)" : "10-digit mobile"}
        hint={
          isStaff
            ? "Optional — used later if the patient claims their record"
            : "Locked after OTP verification"
        }
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
          label="Age *"
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
          label="Address *"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Area / locality"
          enterKeyHint="next"
          required
        />
      </div>

      {!isStaff ? (
        <Input
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Optional"
        />
      ) : null}

      {/* Optional extras collapsed for speed */}
      <div className="rounded-xl border border-dashed border-border bg-background/80 sm:rounded-2xl">
        <button
          type="button"
          className="flex min-h-12 w-full items-center justify-between gap-2 px-3.5 py-2.5 text-left sm:px-4 sm:py-3"
          onClick={() => setShowAadhaarLater((v) => !v)}
        >
          <div>
            <p className="text-sm font-semibold text-foreground">
              {isStaff ? "Optional details" : "Aadhaar (later)"}
            </p>
            <p className="text-xs text-muted">
              {isStaff
                ? "Email · Aadhaar last 4 · auto-fill"
                : "Optional · full integration coming later"}
            </p>
          </div>
          <span className="text-muted" aria-hidden="true">
            {showAadhaarLater ? "▴" : "▾"}
          </span>
        </button>
        {showAadhaarLater ? (
          <div className="space-y-3 border-t border-border px-3.5 pb-3.5 pt-3 sm:px-4 sm:pb-4">
            {isStaff ? (
              <Input
                label="Email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Optional"
              />
            ) : null}
            <Input
              label={
                isStaff && lookupEnabled
                  ? "Aadhaar number"
                  : "Aadhaar (optional)"
              }
              inputMode="numeric"
              autoComplete="off"
              placeholder="XXXX XXXX 1234"
              hint="Never stored in full — last 4 only"
              value={aadhaar}
              onChange={(e) => onAadhaarChange(e.target.value)}
            />
            {isStaff && lookupEnabled && digitsOnly(aadhaar).length === 12 ? (
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
            {lookupMsg && isStaff ? (
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
        {isStaff
          ? "After save they stay registered. Print to join the queue, or a doctor can scan them directly (seen)."
          : "After save you stay signed in with phone OTP. Doctor can scan without a print."}
      </p>
      <ErrorBox message={error} />
      <div className={isStaff ? "sticky-submit" : undefined}>
        <Button
          type="submit"
          disabled={loading || lookupState === "loading" || !campDayId}
          loading={loading}
        >
          {loading
            ? isStaff
              ? "Saving…"
              : "Registering…"
            : isStaff
              ? "Save registration"
              : "Register for selected day"}
        </Button>
      </div>
    </form>
  );
}
