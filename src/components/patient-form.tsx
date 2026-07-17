"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
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
  /** Volunteer/admin desk registration — show print & queue actions */
  isStaff?: boolean;
};

type Created = {
  id: string;
  reg_no: number;
  full_name: string;
  camp_day_id?: string;
  day_date?: string;
  loginUrl?: string;
  accountReady?: boolean;
};

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

  const [campDayId, setCampDayId] = useState(firstOpen);
  const [fullName, setFullName] = useState("");
  const [gender, setGender] = useState("");
  const [age, setAge] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState(defaultPhone);
  const [email, setEmail] = useState("");
  const [aadhaar, setAadhaar] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const [queueNote, setQueueNote] = useState<string | null>(null);
  const [queueBusy, setQueueBusy] = useState(false);

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

    const phoneDigits = phone.replace(/\D/g, "");
    const phone10 = phoneDigits.slice(-10);
    if (phone10.length !== 10) {
      setError(
        "Phone is required (10-digit mobile) to prevent duplicate registration.",
      );
      setLoading(false);
      return;
    }

    const digits = aadhaar.replace(/\D/g, "");
    const last4 = digits.length >= 4 ? digits.slice(-4) : "";
    if (aadhaar.trim() && last4.length !== 4) {
      setError(
        "Aadhaar: enter full number or last 4 digits (only last 4 is stored).",
      );
      setLoading(false);
      return;
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

    const createdRow = row as Created;
    let loginUrl: string | undefined;
    let accountReady = false;

    try {
      const res = await fetch("/api/patient-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientId: createdRow.id,
          regNo: createdRow.reg_no,
          fullName: createdRow.full_name,
        }),
      });
      const json = (await res.json()) as {
        error?: string;
        loginUrl?: string;
      };
      if (!res.ok) {
        setError(
          `Registered (reg ${createdRow.reg_no}) but login QR setup failed: ${json.error || "unknown"}. Desk can still print by reg no.`,
        );
      } else {
        loginUrl = json.loginUrl;
        accountReady = Boolean(json.loginUrl);
      }
    } catch {
      setError(
        `Registered (reg ${createdRow.reg_no}) but login QR setup failed. Desk can still print.`,
      );
    }

    if (!loginUrl && typeof window !== "undefined") {
      loginUrl = `${window.location.origin}/print/${createdRow.id}`;
    }

    setCreated({ ...createdRow, loginUrl, accountReady });
    setLoading(false);
  }

  async function addToQueue() {
    if (!created) return;
    setQueueBusy(true);
    setQueueNote(null);
    setError(null);
    const supabase = createClient();
    const { data, error: err } = await supabase.rpc("join_queue", {
      p_patient_id: created.id,
      p_reg_no: null,
    });
    setQueueBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    const row = (Array.isArray(data) ? data[0] : data) as {
      already_in_queue?: boolean;
      queue_status?: string;
    } | null;
    if (row?.queue_status === "seen") {
      setQueueNote("Already marked seen (printed earlier).");
    } else if (row?.already_in_queue) {
      setQueueNote("Already in the live queue.");
    } else {
      setQueueNote("Added to live queue (waiting).");
    }
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
            Not in queue until check-in
          </p>
        </div>

        {isStaff ? (
          <div className="space-y-3 rounded-2xl border border-border bg-card p-4 shadow-sm">
            <div>
              <p className="text-sm font-semibold text-foreground">
                No smartphone?
              </p>
              <p className="text-xs text-muted">
                Print the prescription on this desk now. Opening print marks the
                patient as <strong>seen</strong>.
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Link
                href={`/print/${created.id}?auto=1`}
                className="inline-flex min-h-12 flex-1 items-center justify-center rounded-xl bg-brand px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-dark"
              >
                Print prescription now
              </Link>
              <Button
                type="button"
                variant="secondary"
                className="sm:w-auto sm:min-w-[10rem]"
                disabled={queueBusy}
                onClick={() => void addToQueue()}
              >
                {queueBusy ? "Adding…" : "Add to queue only"}
              </Button>
            </div>
            {queueNote ? (
              <p className="rounded-xl bg-brand-soft px-3 py-2 text-sm text-brand">
                {queueNote}
              </p>
            ) : null}
            <ErrorBox message={error} />
          </div>
        ) : null}

        <div className="space-y-2">
          <p className="text-center text-xs font-semibold uppercase tracking-wide text-muted">
            {isStaff
              ? "Has a phone? Show this QR"
              : "Your QR — scan to log in anytime"}
          </p>
          <QrCard
            value={created.loginUrl}
            regNo={created.reg_no}
            patientId={created.id}
            staffHint={isStaff}
          />
          {created.accountReady && !isStaff ? (
            <p className="text-center text-xs text-muted">
              No password — scan this QR to open your profile
            </p>
          ) : null}
        </div>

        <div className="rounded-xl border border-border p-4">
          <p className="mb-2 text-sm font-medium">Need a different day?</p>
          <ChangeDay
            patientId={created.id}
            currentDayId={created.camp_day_id || campDayId}
            days={days}
          />
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
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
            }}
          >
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
      <Input
        label="Aadhaar (optional)"
        inputMode="numeric"
        placeholder="XXXX XXXX 1234 or last 4 only"
        hint="Only last 4 digits are stored"
        value={aadhaar}
        onChange={(e) => setAadhaar(e.target.value)}
      />
      <p className="rounded-xl border border-border bg-background px-3 py-2.5 text-xs text-muted">
        {isStaff
          ? "No password. After save: print here if they have no phone, or show the QR so they can log in on their phone. Desk scan adds them to the queue; print marks them seen."
          : "No password. After save, scan the QR on your phone to open your profile anytime."}
      </p>
      <ErrorBox message={error} />
      <Button type="submit" disabled={loading}>
        {loading ? "Saving…" : "Register for selected day"}
      </Button>
    </form>
  );
}
