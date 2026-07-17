"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button, Card, ErrorBox, Input, Shell } from "@/components/ui";

function normalizePhone(raw: string) {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.startsWith("91") && digits.length === 12) return `+${digits}`;
  if (raw.startsWith("+")) return raw;
  return `+${digits}`;
}

export default function PatientLoginPage() {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [step, setStep] = useState<"phone" | "otp">("phone");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function sendOtp(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { error: err } = await supabase.auth.signInWithOtp({
      phone: normalizePhone(phone),
    });
    if (err) {
      setError(
        err.message +
          " — Enable Phone auth + SMS provider in Supabase (Authentication → Providers).",
      );
      setLoading(false);
      return;
    }
    setStep("otp");
    setLoading(false);
  }

  async function verifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const phoneE164 = normalizePhone(phone);
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

    // Link unclaimed patient rows with same phone
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      await supabase
        .from("profiles")
        .update({ phone: phoneE164, role: "patient" })
        .eq("id", user.id);
      await supabase
        .from("patients")
        .update({ user_id: user.id })
        .is("user_id", null)
        .eq("phone", phoneE164);
      // also try raw 10-digit match
      const ten = phoneE164.replace(/\D/g, "").slice(-10);
      await supabase
        .from("patients")
        .update({ user_id: user.id })
        .is("user_id", null)
        .eq("phone", ten);
    }

    router.replace("/patient");
    router.refresh();
  }

  return (
    <Shell title="Patient login" backHref="/">
      <Card>
        {step === "phone" ? (
          <form onSubmit={sendOtp} className="space-y-4">
            <Input
              label="Mobile number"
              inputMode="tel"
              placeholder="10-digit Indian mobile"
              required
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
            <ErrorBox message={error} />
            <Button type="submit" disabled={loading}>
              {loading ? "Sending…" : "Send OTP"}
            </Button>
          </form>
        ) : (
          <form onSubmit={verifyOtp} className="space-y-4">
            <p className="text-sm text-muted">OTP sent to {normalizePhone(phone)}</p>
            <Input
              label="OTP"
              inputMode="numeric"
              required
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
            />
            <ErrorBox message={error} />
            <Button type="submit" disabled={loading}>
              {loading ? "Verifying…" : "Verify & continue"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setStep("phone")}>
              Change number
            </Button>
          </form>
        )}
      </Card>
    </Shell>
  );
}
