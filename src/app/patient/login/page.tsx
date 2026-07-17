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
    <Shell
      title="Patient login"
      subtitle="Phone OTP to view your QR"
      backHref="/"
    >
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
              hint="We'll send a one-time code via SMS"
            />
            <ErrorBox message={error} />
            <Button type="submit" disabled={loading}>
              {loading ? "Sending…" : "Send OTP"}
            </Button>
          </form>
        ) : (
          <form onSubmit={verifyOtp} className="space-y-4">
            <p className="rounded-xl bg-brand-soft px-3 py-2 text-sm text-brand">
              OTP sent to <strong>{normalizePhone(phone)}</strong>
            </p>
            <Input
              label="OTP"
              inputMode="numeric"
              required
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              placeholder="6-digit code"
              autoComplete="one-time-code"
            />
            <ErrorBox message={error} />
            <Button type="submit" disabled={loading}>
              {loading ? "Verifying…" : "Verify & continue"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setStep("phone");
                setOtp("");
                setError(null);
              }}
            >
              Change number
            </Button>
          </form>
        )}
      </Card>
    </Shell>
  );
}
