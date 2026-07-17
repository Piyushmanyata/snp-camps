"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { formatCampDay, type CampDayStats } from "@/lib/types";
import { Button, ErrorBox, Input, Select } from "@/components/ui";
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
};

type LookupState = "idle" | "loading" | "ok" | "fail" | "skipped";

export function PatientForm({
  campId,
  days,
  defaultPhone = "",
  userId = null,
  createdBy = null,
  isStaff = false,
}: Props) {
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

  const [lookupState, setLookupState] = useState<LookupState>("idle");
  const [lookupMsg, setLookupMsg] = useState<string | null>(null);
  const [filledFromAadhaar, setFilledFromAadhaar] = useState(false);
  const lookupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLookedUp = useRef<string>("");

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

      setLookupState("loading");
      setLookupMsg("Fetching details from Aadhaar…");
      setError(null);

      try {
        const res = await fetch("/api/aadhaar-lookup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ aadhaar: d }),
        });
        const json = (await res.json()) as {
          available?: boolean;
          error?: string;
          profile?: AadhaarProfile;
        };

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
          setLookupMsg("Details filled from Aadhaar — edit if anything is wrong.");
        } else {
          setLookupState("fail");
          setLookupMsg("No details returned. Fill the form manually.");
          setFilledFromAadhaar(false);
        }
      } catch {
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

    const d = digitsOnly(formatted);
    if (lookupTimer.current) clearTimeout(lookupTimer.current);

    if (!lookupEnabled) {
      setLookupState("skipped");
      setLookupMsg(
        d.length >= 4
          ? "Only last 4 digits are stored. Enter other details below."
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
      setLookupMsg("Invalid Aadhaar number. Check digits or enter details manually.");
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

    if (!fullName.trim()) {
      setError("Full name is required.");
      setLoading(false);
      return;
    }

    const phoneDigits = phone.replace(/\D/g, "");
    const phone10 = phoneDigits.slice(-10);
    if (phone10.length !== 10) {
      setError(
        "Phone is required (10-digit mobile) to prevent duplicate registration.",
      );
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
        setError("Aadhaar: enter full number or last 4 digits (only last 4 is stored).");
        setLoading(false);
        return;
      }
    }

    const supabase = createClient();
    const { data, error: err } = await supabase.rpc("register_patient", {
      p_camp_id: campId,
      p_full_name: fullName.trim(),
      p_gender: gender || null,
      p_age: age ? Number(age) : null,
      p_address: address.trim() || null,
      p_phone: phone10,
      p_email: email.trim() || null,
      p_aadhaar_last4: last4 || null,
      p_user_id: userId,
      p_created_by: createdBy,
      p_camp_day_id: campDayId,
    });

    if (err) {
      setError(err.message || "Registration failed");
      setLoading(false);
      return;
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      setError("Registration failed — no row returned.");
      setLoading(false);
      return;
    }

    // Stay registered until print. No auth account / no on-screen desk QR.
    // Paper form QR (after print) is for staff scan only.
    setCreated(row as Created);
    setQueueNote(
      isStaff
        ? "Registered only. Print prescription to put them in the queue."
        : null,
    );
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
    lastLookedUp.current = "";
  }

  if (created) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-brand/20 bg-brand-soft px-4 py-3 text-center">
          <p className="text-sm font-semibold text-brand">
            Registered · #{created.reg_no}
          </p>
          <p className="text-lg font-bold text-foreground">
            {created.full_name}
          </p>
          <p className="mt-0.5 text-xs text-brand/80">
            {created.day_date
              ? `Day: ${formatCampDay(created.day_date)} · `
              : ""}
            {isStaff
              ? "Registered at desk — print to join queue"
              : "Not in queue until desk prints your form"}
          </p>
        </div>

        {isStaff ? (
          <div className="space-y-3 rounded-2xl border border-border bg-card p-4 shadow-sm">
            {queueNote ? (
              <p className="rounded-xl bg-brand-soft px-3 py-2 text-sm text-brand">
                {queueNote}
              </p>
            ) : null}
            <div>
              <p className="text-sm font-semibold text-foreground">
                Print prescription
              </p>
              <p className="text-xs text-muted">
                Paper form only — no on-screen QR. Print puts them{" "}
                <strong>in the queue</strong>. The QR is on the printed sheet
                for later doctor/volunteer scan.
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Link
                href={`/print/${created.id}?auto=1`}
                className="inline-flex min-h-12 flex-1 items-center justify-center rounded-xl bg-brand px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-dark"
              >
                Print now (join queue)
              </Link>
            </div>
            <ErrorBox message={error} />
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-center text-xs font-semibold uppercase tracking-wide text-muted">
              Show this at the desk
            </p>
            <QrCard regNo={created.reg_no} patientId={created.id} />
            <p className="text-center text-xs text-muted">
              Keep reg #{created.reg_no}. Desk prints your form (queue), then
              scans when a doctor sees you.
            </p>
          </div>
        )}

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
          <Button type="button" variant="secondary" onClick={resetForm}>
            Register another
          </Button>
          {isStaff ? (
            <Link
              href="/volunteer"
              className="inline-flex min-h-12 flex-1 items-center justify-center rounded-xl border border-border bg-white px-4 text-sm font-semibold text-brand"
            >
              Back to volunteer desk
            </Link>
          ) : null}
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
      <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
        All days are full. You can still view seat status on the home page —
        registration reopens if seats free up or admin raises limits.
      </p>
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

      {/* Aadhaar first — auto-fill when lookup is enabled */}
      <div
        className={`space-y-2 rounded-2xl border p-4 ${
          filledFromAadhaar
            ? "border-brand/30 bg-brand-soft/40"
            : "border-border bg-background/80"
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold text-foreground">Aadhaar</p>
            <p className="text-xs text-muted">
              {lookupEnabled
                ? "Enter 12 digits — details fill automatically when the service is available."
                : "Optional. Enter full number or last 4. Only last 4 is stored."}
            </p>
          </div>
          {lookupEnabled ? (
            <span className="shrink-0 rounded-full bg-brand-soft px-2.5 py-1 text-[11px] font-semibold text-brand ring-1 ring-brand/15">
              Auto-fill on
            </span>
          ) : (
            <span className="shrink-0 rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-semibold text-gray-600 ring-1 ring-gray-200">
              Manual form
            </span>
          )}
        </div>

        <Input
          label={lookupEnabled ? "Aadhaar number" : "Aadhaar (optional)"}
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
            {lookupState === "loading" ? "Fetching…" : "Fetch details again"}
          </Button>
        ) : null}

        {lookupMsg ? (
          <p
            className={`rounded-xl px-3 py-2 text-xs ${
              lookupState === "ok"
                ? "bg-brand-soft text-brand"
                : lookupState === "fail"
                  ? "border border-amber-200 bg-amber-50 text-amber-950"
                  : lookupState === "loading"
                    ? "bg-background text-muted"
                    : "bg-background text-muted"
            }`}
          >
            {lookupMsg}
          </p>
        ) : null}
      </div>

      <div className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">
          {filledFromAadhaar
            ? "Review & edit details"
            : "Patient details (fill manually if Aadhaar not available)"}
        </p>
      </div>

      <Input
        label="Full name *"
        required
        autoComplete="name"
        value={fullName}
        onChange={(e) => setFullName(e.target.value)}
        placeholder="As on ID card"
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
          label="Phone *"
          inputMode="tel"
          autoComplete="tel"
          required
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="10-digit mobile"
          hint="One registration per phone"
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
      <p className="rounded-xl border border-border bg-background px-3 py-2.5 text-xs text-muted">
        {isStaff
          ? "After save they stay registered. Print the paper form to put them in the queue (QR is on the printout only). Later scan assigns a doctor (seen)."
          : "After save you are registered only. Show your reg number or QR at the desk for print (queue), then doctor scan (seen)."}
      </p>
      <ErrorBox message={error} />
      <Button type="submit" disabled={loading || lookupState === "loading"}>
        {loading ? "Saving…" : "Register for selected day"}
      </Button>
    </form>
  );
}
