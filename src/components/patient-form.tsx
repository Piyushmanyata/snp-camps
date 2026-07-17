"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button, ErrorBox, Input, Select } from "@/components/ui";
import { QrCard } from "@/components/qr-card";

type Props = {
  campId: string;
  defaultPhone?: string;
  userId?: string | null;
  createdBy?: string | null;
};

type Created = {
  id: string;
  reg_no: number;
  full_name: string;
};

export function PatientForm({
  campId,
  defaultPhone = "",
  userId = null,
  createdBy = null,
}: Props) {
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

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

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
    });

    if (err) {
      const msg = err.message || "Registration failed";
      setError(
        /already registered/i.test(msg)
          ? msg
          : msg,
      );
      setLoading(false);
      return;
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      setError("Registration failed — no row returned.");
      setLoading(false);
      return;
    }

    setCreated(row as Created);
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
            Not in queue yet — show this QR at the desk so a volunteer can check
            you in
          </p>
        </div>
        <QrCard
          value={origin ? `${origin}/print/${created.id}` : undefined}
          regNo={created.reg_no}
          patientId={created.id}
        />
        <p className="text-center text-lg font-semibold">{created.full_name}</p>
        <Button type="button" variant="secondary" onClick={() => setCreated(null)}>
          Register another
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Input
        label="Full name *"
        required
        autoComplete="name"
        value={fullName}
        onChange={(e) => setFullName(e.target.value)}
        placeholder="As on ID card"
      />
      <div className="grid grid-cols-2 gap-3">
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
      <Input
        label="Phone *"
        inputMode="tel"
        autoComplete="tel"
        required
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        placeholder="10-digit mobile"
        hint="Used to stop the same person registering twice"
      />
      <Input
        label="Email"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Optional"
      />
      <Input
        label="Aadhaar (optional)"
        inputMode="numeric"
        placeholder="XXXX XXXX 1234 or last 4 only"
        hint="Only last 4 digits are stored"
        value={aadhaar}
        onChange={(e) => setAadhaar(e.target.value)}
      />
      <ErrorBox message={error} />
      <Button type="submit" disabled={loading}>
        {loading ? "Saving…" : "Register & join queue"}
      </Button>
    </form>
  );
}
