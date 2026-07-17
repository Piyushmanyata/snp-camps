"use client";

import { useMemo, useState } from "react";
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
};

type Created = {
  id: string;
  reg_no: number;
  full_name: string;
  camp_day_id?: string;
  day_date?: string;
  passwordSet?: boolean;
};

export function PatientForm({
  campId,
  days,
  defaultPhone = "",
  userId = null,
  createdBy = null,
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
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

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

    if (password.length < 6) {
      setError("Choose a password (min 6 characters) to log in later with your reg no.");
      setLoading(false);
      return;
    }
    if (password !== password2) {
      setError("Passwords do not match.");
      setLoading(false);
      return;
    }

    const phoneDigits = phone.replace(/\D/g, "");
    const phone10 = phoneDigits.slice(-10);
    if (phone10.length !== 10) {
      setError("Phone is required (10-digit mobile) to prevent duplicate registration.");
      setLoading(false);
      return;
    }

    const digits = aadhaar.replace(/\D/g, "");
    const last4 = digits.length >= 4 ? digits.slice(-4) : "";
    if (aadhaar.trim() && last4.length !== 4) {
      setError("Aadhaar: enter full number or last 4 digits (only last 4 is stored).");
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
    let passwordSet = false;
    try {
      const res = await fetch("/api/patient-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientId: createdRow.id,
          regNo: createdRow.reg_no,
          password,
          fullName: createdRow.full_name,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(
          `Registered (reg ${createdRow.reg_no}) but login setup failed: ${json.error || "unknown"}. Save your QR; admin can help set a password later.`,
        );
      } else {
        passwordSet = true;
      }
    } catch {
      setError(
        `Registered (reg ${createdRow.reg_no}) but login setup failed. Save your QR.`,
      );
    }

    setCreated({ ...createdRow, passwordSet });
    setLoading(false);
  }

  if (created) {
    const site = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
    const origin =
      site || (typeof window !== "undefined" ? window.location.origin : "");
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-brand/20 bg-brand-soft px-4 py-3 text-center">
          <p className="text-sm font-semibold text-brand">Registered successfully</p>
          <p className="text-xs text-brand/80">
            {created.day_date
              ? `Day: ${formatCampDay(created.day_date)} · `
              : ""}
            Not in queue yet — show QR at the desk for check-in
          </p>
          {created.passwordSet ? (
            <p className="mt-1 text-xs text-brand/90">
              Login later with reg no <strong>{created.reg_no}</strong> + your password
            </p>
          ) : null}
        </div>
        <QrCard
          value={origin ? `${origin}/print/${created.id}` : undefined}
          regNo={created.reg_no}
          patientId={created.id}
        />
        <p className="text-center text-lg font-semibold">{created.full_name}</p>
        <div className="rounded-xl border border-border p-4">
          <p className="mb-2 text-sm font-medium">Need a different day?</p>
          <ChangeDay
            patientId={created.id}
            currentDayId={created.camp_day_id || campDayId}
            days={days}
          />
        </div>
        <Button type="button" variant="secondary" onClick={() => setCreated(null)}>
          Register another
        </Button>
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
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input
          label="Login password *"
          type="password"
          autoComplete="new-password"
          required
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Min 6 characters"
          hint="Use with your reg no to view QR later"
        />
        <Input
          label="Confirm password *"
          type="password"
          autoComplete="new-password"
          required
          minLength={6}
          value={password2}
          onChange={(e) => setPassword2(e.target.value)}
          placeholder="Repeat password"
        />
      </div>
      <ErrorBox message={error} />
      <Button type="submit" disabled={loading}>
        {loading ? "Saving…" : "Register for selected day"}
      </Button>
    </form>
  );
}
