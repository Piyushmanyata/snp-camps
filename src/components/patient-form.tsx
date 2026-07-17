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
    const { data, error: err } = await supabase
      .from("patients")
      .insert({
        camp_id: campId,
        user_id: userId,
        full_name: fullName.trim(),
        gender: gender || null,
        age: age ? Number(age) : null,
        address: address.trim() || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        aadhaar_last4: last4 || null,
        created_by: createdBy,
        queue_status: "waiting",
      })
      .select("id, reg_no, full_name")
      .single();

    if (err) {
      setError(err.message);
      setLoading(false);
      return;
    }

    setCreated(data as Created);
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
