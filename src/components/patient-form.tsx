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
import { patientAuthEmail } from "@/lib/patient-auth";
import { formatCampDay, type CampDayStats } from "@/lib/types";
import {
  Button,
  ErrorBox,
  Input,
  Select,
  SuccessBox,
  WarningBox,
} from "@/components/ui";
import { QrCard } from "@/components/qr-card";
import { ChangeDay } from "@/components/change-day";

type Props = {
  campId: string;
  days: CampDayStats[];
  defaultPhone?: string;
  userId?: string | null;
  createdBy?: string | null;
  /** Volunteer/admin desk registration — print only, no on-screen QR */
  isStaff?: boolean;
};

type Created = {
  id: string;
  reg_no: number;
  full_name: string;
  camp_day_id?: string;
  day_date?: string;
  claim_token?: string | null;
  /** Shown once after self-reg (and on logout re-issue) */
  password?: string;
  loggedIn?: boolean;
  notifyNote?: string;
};

type LookupState = "idle" | "loading" | "ok" | "fail" | "skipped";
type VerifyState = "idle" | "loading" | "ok" | "fail";

export function PatientForm({
  campId,
  days,
  defaultPhone = "",
  userId = null,
  createdBy = null,
  isStaff = false,
}: Props) {
  const router = useRouter();
  const openDays = useMemo(() => days.filter((d) => !d.is_full), [days]);
  const firstOpen = openDays[0]?.id || "";
  const lookupEnabled = isAadhaarLookupEnabledClient();

  const [campDayId, setCampDayId] = useState(firstOpen);
  const [aadhaar, setAadhaar] = useState("");
  const [aadhaarVerified, setAadhaarVerified] = useState(false);
  const [verificationToken, setVerificationToken] = useState("");
  const [verifyState, setVerifyState] = useState<VerifyState>("idle");
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);
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

  const [lookupState, setLookupState] = useState<LookupState>("idle");
  const [lookupMsg, setLookupMsg] = useState<string | null>(null);
  const [filledFromAadhaar, setFilledFromAadhaar] = useState(false);
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

  async function verifyAadhaar() {
    const d = digitsOnly(aadhaar);
    setError(null);
    setAadhaarVerified(false);
    if (!isValidAadhaarNumber(d)) {
      setVerifyState("fail");
      setVerifyMsg("Enter a valid 12-digit Aadhaar number.");
      return;
    }

    setVerifyState("loading");
    setVerifyMsg("Verifying Aadhaar…");
    try {
      const res = await fetch("/api/aadhaar-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aadhaar: d }),
      });
      const json = (await res.json()) as {
        verified?: boolean;
        validated?: boolean;
        error?: string;
        message?: string;
        mode?: string;
        verificationToken?: string;
      };
      if (
        !res.ok ||
        json.verified !== true ||
        !/^[0-9a-f]{64}$/i.test(json.verificationToken || "")
      ) {
        setVerifyState("fail");
        setVerifyMsg(json.error || "Aadhaar verification failed.");
        return;
      }
      setAadhaarVerified(true);
      setVerificationToken(json.verificationToken || "");
      setVerifyState("ok");
      setVerifyMsg(json.message || "Aadhaar verified.");
      if (lookupEnabled && isStaff) void runAadhaarLookup(d);
    } catch {
      setVerifyState("fail");
      setVerifyMsg("Verification request failed. Try again.");
    }
  }

  function onAadhaarChange(value: string) {
    const formatted = formatAadhaarDisplay(value);
    setAadhaar(formatted);
    setFilledFromAadhaar(false);
    setAadhaarVerified(false);
    setVerificationToken("");
    setVerifyState("idle");
    setVerifyMsg(null);
    lastLookedUp.current = "";
    lookupRequest.current += 1;
    lookupAbort.current?.abort();

    const d = digitsOnly(formatted);
    if (lookupTimer.current) clearTimeout(lookupTimer.current);

    if (!lookupEnabled) {
      setLookupState("skipped");
      setLookupMsg(
        d.length >= 4
          ? isStaff
            ? "Only last 4 digits are stored. Enter other details below."
            : "Self-registration requires full Aadhaar verification."
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

    // Self-reg waits for explicit verify; staff can auto-lookup
    if (isStaff) {
      setLookupState("loading");
      setLookupMsg("Fetching details…");
      lookupTimer.current = setTimeout(() => {
        void runAadhaarLookup(d);
      }, 450);
    }
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

    // Self-registration: Aadhaar only (must verify)
    if (!isStaff) {
      if (!isValidAadhaarNumber(aDigits)) {
        setError("Self-registration requires a valid 12-digit Aadhaar.");
        setLoading(false);
        return;
      }
      if (!aadhaarVerified || !verificationToken) {
        setError("Verify your Aadhaar first, then complete registration.");
        setLoading(false);
        return;
      }
    } else if (aadhaar.trim()) {
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

    const phoneDigits = phone.replace(/\D/g, "");
    const phone10 = phoneDigits.slice(-10);
    if (isStaff && phone10.length !== 10) {
      setError("Phone is required (10-digit mobile) to prevent duplicate registration.");
      setLoading(false);
      return;
    }

    const ageValue = age === "" ? null : Number(age);
    if (
      ageValue !== null &&
      (!Number.isInteger(ageValue) || ageValue < 0 || ageValue >= 150)
    ) {
      setError("Age must be a whole number from 0 to 149.");
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
            verificationToken,
            campId,
            campDayId,
            fullName: fullName.trim(),
            gender: gender || null,
            age: ageValue,
            address: address.trim() || null,
            phone: phone10 || null,
            email: email.trim() || null,
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

    // Staff: registered only until print
    if (isStaff) {
      setCreated(base);
      setQueueNote(
        "Registered only. Print prescription to put them in the queue (optional if doctor will scan).",
      );
      setLoading(false);
      return;
    }

    // Self-reg: create account → notify SMS/WA → sign in → show credentials
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
      const acc = (await accRes.json()) as {
        error?: string;
        password?: string;
        notify?: { sms?: string; whatsapp?: string };
        notifyConfigured?: { sms?: boolean; whatsapp?: boolean };
        message?: string;
      };

      if (!accRes.ok) {
        setCreated(base);
        setError(
          acc.error ||
            "Registered, but login account failed. Ask the desk for help.",
        );
        setLoading(false);
        return;
      }

      if (acc.message && !acc.password) {
        setCreated(base);
        setError(acc.message);
        setLoading(false);
        return;
      }

      let loggedIn = false;
      if (acc.password) {
        const { error: signErr } = await supabase.auth.signInWithPassword({
          email: patientAuthEmail(base.reg_no),
          password: acc.password,
        });
        loggedIn = !signErr;
      }

      const smsOn = acc.notifyConfigured?.sms;
      const waOn = acc.notifyConfigured?.whatsapp;
      let notifyNote =
        "Save your reg number and password. They are also sent by SMS/WhatsApp when those services are configured.";
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
        loggedIn,
        notifyNote,
      });
      if (loggedIn) router.refresh();
    } catch {
      setCreated(base);
      setError(
        "Registered, but could not finish login setup. Use reg no at the desk.",
      );
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
    setAadhaarVerified(false);
    setVerifyState("idle");
    setVerifyMsg(null);
    setLookupState("idle");
    setLookupMsg(null);
    setFilledFromAadhaar(false);
    setCampDayId(firstOpen);
    lastLookedUp.current = "";
    lookupRequest.current += 1;
    lookupAbort.current?.abort();
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
              : created.loggedIn
                ? "You are logged in — save your password below"
                : "Save your login details"}
          </p>
        </div>

        {!isStaff && created.password ? (
          <div className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4">
            <p className="text-sm font-bold text-amber-950">
              Your login (save now)
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
                "These are also sent by SMS/WhatsApp when configured."}
            </p>
            <p className="text-xs text-muted">
              If you sign out, we show your reg no and a new password again (and
              re-send by SMS/WhatsApp when configured).
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
                }}
              >
                Copy login
              </Button>
            </div>
          </div>
        ) : null}

        {isStaff ? (
          <div className="space-y-3 rounded-2xl border border-border bg-card p-4 shadow-sm">
            {queueNote ? <SuccessBox message={queueNote} /> : null}
            <div>
              <p className="text-sm font-semibold text-foreground">
                Print prescription (optional)
              </p>
              <p className="prose-help mt-0.5 text-xs text-muted">
                Print puts them in the live queue. Doctors can also scan a
                registered patient directly without printing.
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Link
                href={`/print/${created.id}?auto=1`}
                className="pressable inline-flex min-h-12 flex-1 items-center justify-center rounded-xl bg-brand px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-dark"
              >
                Print now (join queue)
              </Link>
            </div>
            <ErrorBox message={error} />
          </div>
        ) : !created.password ? (
          <div className="space-y-2">
            <ErrorBox message={error} />
            <p className="text-center text-xs font-semibold uppercase tracking-wide text-muted">
              Show this at the desk if needed
            </p>
            <QrCard regNo={created.reg_no} patientId={created.id} />
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
            <>
              <Button type="button" variant="secondary" onClick={resetForm}>
                Register another
              </Button>
              <Link
                href="/volunteer"
                className="pressable inline-flex min-h-12 flex-1 items-center justify-center rounded-xl border border-border bg-white px-4 text-sm font-semibold text-brand hover:bg-brand-soft"
              >
                Back to volunteer desk
              </Link>
            </>
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

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Select
        label="Camp day *"
        required
        value={campDayId}
        onChange={(e) => setCampDayId(e.target.value)}
      >
        <option value="">Select day…</option>
        {days.map((d) => (
          <option key={d.id} value={d.id} disabled={d.is_full}>
            {formatCampDay(d.day_date)}
            {d.is_full ? " · FULL" : ` · ${d.seats_left} seats left`}
          </option>
        ))}
      </Select>

      <div
        className={`space-y-2 rounded-2xl border p-4 ${
          aadhaarVerified || filledFromAadhaar
            ? "border-brand/30 bg-brand-soft/40"
            : "border-border bg-background/80"
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold text-foreground">
              Aadhaar{!isStaff ? " *" : ""}
            </p>
            <p className="text-xs text-muted">
              {!isStaff
                ? "Self-registration is Aadhaar-only. Verify, then complete details."
                : lookupEnabled
                  ? "Enter 12 digits — details fill when the service is available."
                  : "Optional at desk. Full number or last 4. Only last 4 is stored."}
            </p>
          </div>
          {!isStaff ? (
            <span className="shrink-0 rounded-full bg-brand-soft px-2.5 py-1 text-[11px] font-semibold text-brand ring-1 ring-brand/15">
              Required
            </span>
          ) : lookupEnabled ? (
            <span className="shrink-0 rounded-full bg-brand-soft px-2.5 py-1 text-[11px] font-semibold text-brand ring-1 ring-brand/15">
              Auto-fill on
            </span>
          ) : (
            <span className="shrink-0 rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-semibold text-gray-600 ring-1 ring-gray-200">
              Optional
            </span>
          )}
        </div>

        <Input
          label={
            !isStaff
              ? "Aadhaar number *"
              : lookupEnabled
                ? "Aadhaar number"
                : "Aadhaar (optional)"
          }
          inputMode="numeric"
          autoComplete="off"
          placeholder="XXXX XXXX 1234"
          hint="Never stored in full — last 4 only"
          required={!isStaff}
          value={aadhaar}
          onChange={(e) => onAadhaarChange(e.target.value)}
        />

        {!isStaff ? (
          <Button
            type="button"
            variant={aadhaarVerified ? "secondary" : "primary"}
            size="sm"
            disabled={
              verifyState === "loading" ||
              digitsOnly(aadhaar).length !== 12
            }
            loading={verifyState === "loading"}
            onClick={() => void verifyAadhaar()}
          >
            {aadhaarVerified
              ? "Verified ✓"
              : verifyState === "loading"
                ? "Verifying…"
                : "Verify Aadhaar"}
          </Button>
        ) : null}

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
            {lookupState === "loading" ? "Fetching…" : "Fetch details again"}
          </Button>
        ) : null}

        {verifyMsg ? (
          <p
            role="status"
            aria-live="polite"
            className={`rounded-xl px-3 py-2 text-xs ${
              verifyState === "ok"
                ? "bg-brand-soft text-brand"
                : verifyState === "fail"
                  ? "border border-amber-200 bg-amber-50 text-amber-950"
                  : "bg-background text-muted"
            }`}
          >
            {verifyMsg}
          </p>
        ) : null}

        {lookupMsg && isStaff ? (
          <p
            role="status"
            aria-live="polite"
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
      </div>

      {!isStaff && !aadhaarVerified ? (
        <div className="rounded-xl border border-dashed border-border bg-card px-4 py-5 text-center">
          <p className="font-semibold text-foreground">Step 2 · Patient details</p>
          <p className="mt-1 text-sm text-muted">
            Verify Aadhaar above to continue. Your details stay hidden until then.
          </p>
        </div>
      ) : null}

      <div className={!isStaff && !aadhaarVerified ? "hidden" : "space-y-1"}>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">
          {filledFromAadhaar
            ? "Review & edit details"
            : !isStaff && !aadhaarVerified
              ? "Verify Aadhaar above first"
              : "Patient details"}
        </p>
      </div>

      <fieldset
        disabled={!isStaff && !aadhaarVerified}
        className={
          !isStaff && !aadhaarVerified
            ? "hidden"
            : "space-y-4 disabled:opacity-60"
        }
      >
        <Input
          label="Full name *"
          required
          autoComplete="name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          placeholder="As on Aadhaar / ID"
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select
            label="Gender"
            value={gender}
            onChange={(e) => setGender(e.target.value)}
          >
            <option value="">—</option>
            <option value="M">Male</option>
            <option value="F">Female</option>
            <option value="O">Other</option>
          </Select>
          <Input
            label="Age"
            type="number"
            min={0}
            max={149}
            inputMode="numeric"
            value={age}
            onChange={(e) => setAge(e.target.value)}
            placeholder="Years"
          />
        </div>
        <Input
          label="Address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Locality / area"
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input
            label={isStaff ? "Phone *" : "Phone (optional)"}
            inputMode="tel"
            autoComplete="tel"
            required={isStaff}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="10-digit mobile"
            hint={
              isStaff
                ? "One registration per phone"
                : "Optional · Reg no + password sent here when configured"
            }
          />
          <Input
            label="Email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Optional"
          />
        </div>
      </fieldset>

      <p
        className={
          "rounded-xl border border-border bg-background px-3 py-2.5 text-xs text-muted " +
          (!isStaff && !aadhaarVerified ? "hidden" : "")
        }
      >
        {isStaff
          ? "After save they stay registered. Print to join the queue, or a doctor can scan them directly (seen)."
          : "After verify + save you are logged in. Keep your reg number and password. Doctor can scan without a print."}
      </p>
      <ErrorBox message={error} />
      {isStaff || aadhaarVerified ? (
        <Button
          type="submit"
          disabled={
            loading ||
            lookupState === "loading" ||
            verifyState === "loading"
          }
          loading={loading}
        >
          {loading
            ? isStaff
              ? "Saving…"
              : "Registering & signing you in…"
            : isStaff
              ? "Register for selected day"
              : "Verify done · Register & sign in"}
        </Button>
      ) : null}
    </form>
  );
}
