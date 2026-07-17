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

    const digits = aadhaar.replace(/\D/g, "");
    const last4 = digits.length >= 4 ? digits.slice(-4) : "";
    if (aadhaar.trim() && last4.length !== 4) {
      setError("Aadhaar: enter full number or last 4 digits (only last 4 is stored).");
      setLoading(false);
      return;
    }

    const supabase = createClient();
    // RPC is security definer — avoids RLS insert+select RETURNING failures for walk-up/anon
    const { data, error: err } = await supabase.rpc("register_patient", {
      p_camp_id: campId,
      p_full_name: fullName.trim(),
      p_gender: gender || null,
      p_age: age ? Number(age) : null,
      p_address: address.trim() || null,
      p_phone: phone.trim() || null,
      p_email: email.trim() || null,
      p_aadhaar_last4: last4 || null,
      p_user_id: userId,
      p_created_by: createdBy,
    });

    if (err) {
      setError(err.message);
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
    const origin =
      typeof window !== "undefined" ? window.location.origin : "";
    return (
      <div className="space-y-4">
        <p className="text-center text-sm font-medium text-brand">
          Registered — show QR at the desk
        </p>
        <QrCard
          value={`${origin}/print/${created.id}`}
          regNo={created.reg_no}
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
        value={fullName}
        onChange={(e) => setFullName(e.target.value)}
      />
      <div className="grid grid-cols-2 gap-3">
        <Select label="Gender" value={gender} onChange={(e) => setGender(e.target.value)}>
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
          value={age}
          onChange={(e) => setAge(e.target.value)}
        />
      </div>
      <Input label="Address" value={address} onChange={(e) => setAddress(e.target.value)} />
      <Input
        label="Phone"
        inputMode="tel"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
      />
      <Input
        label="Email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <Input
        label="Aadhaar (optional — only last 4 stored)"
        inputMode="numeric"
        placeholder="XXXX XXXX 1234 or 1234"
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
