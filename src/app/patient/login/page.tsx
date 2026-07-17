"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { patientAuthEmail } from "@/lib/patient-auth";
import { Button, Card, ErrorBox, Input, Shell } from "@/components/ui";

function normalizePhone(raw: string) {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.startsWith("91") && digits.length === 12) return `+${digits}`;
  if (raw.startsWith("+")) return raw;
  return `+${digits}`;
}

type Mode = "password" | "otp";

export default function PatientLoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("password");

  // Reg no + password
  const [regNo, setRegNo] = useState("");
  const [password, setPassword] = useState("");

  // Phone OTP (SMS provider later)
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [otpStep, setOtpStep] = useState<"phone" | "otp">("phone");

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function loginWithPassword(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const n = Number(String(regNo).replace(/\D/g, ""));
    if (!Number.isFinite(n) || n <= 0) {
      setError("Enter your registration number.");
      setLoading(false);
      return;
    }
    if (password.length < 6) {
      setError("Enter your password.");
      setLoading(false);
      return;
    }

    const supabase = createClient();
    const { error: err } = await supabase.auth.signInWithPassword({
      email: patientAuthEmail(n),
      password,
    });

    if (err) {
      const msg = err.message.toLowerCase();
      setError(
        msg.includes("invalid") || msg.includes("credentials")
          ? "Wrong reg no or password. Use the password set at registration."
          : err.message,
      );
      setLoading(false);
      return;
    }

    router.replace("/patient");
    router.refresh();
  }

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
          " — Phone OTP needs SMS configured in Supabase (Authentication → Providers). Use reg no + password for now.",
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
      subtitle="View QR, queue status, change day"
      backHref="/"
      width="md"
    >
      <Card>
        <div className="mb-4 grid grid-cols-2 gap-2 rounded-xl bg-background p-1">
          <button
            type="button"
            className={`rounded-lg px-3 py-2.5 text-sm font-semibold transition ${
              mode === "password"
                ? "bg-card text-brand shadow-sm ring-1 ring-border"
                : "text-muted hover:text-foreground"
            }`}
            onClick={() => {
              setMode("password");
              setError(null);
            }}
          >
            Reg no + password
          </button>
          <button
            type="button"
            className={`rounded-lg px-3 py-2.5 text-sm font-semibold transition ${
              mode === "otp"
                ? "bg-card text-brand shadow-sm ring-1 ring-border"
                : "text-muted hover:text-foreground"
            }`}
            onClick={() => {
              setMode("otp");
              setError(null);
            }}
          >
            Phone OTP
          </button>
        </div>

        {mode === "password" ? (
          <form onSubmit={loginWithPassword} className="space-y-4">
            <Input
              label="Registration number"
              inputMode="numeric"
              required
              value={regNo}
              onChange={(e) => setRegNo(e.target.value)}
              placeholder="e.g. 1001"
              autoComplete="username"
              hint="Shown on your QR card after registration"
            />
            <Input
              label="Password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password set at registration"
              autoComplete="current-password"
            />
            <ErrorBox message={error} />
            <Button type="submit" disabled={loading}>
              {loading ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        ) : (
          <div className="space-y-4">
            <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-950">
              Phone OTP will work after SMS is configured in Supabase. Prefer{" "}
              <strong>reg no + password</strong> for now.
            </p>
            {otpStep === "phone" ? (
              <form onSubmit={sendOtp} className="space-y-4">
                <Input
                  label="Mobile number"
                  inputMode="tel"
                  placeholder="10-digit Indian mobile"
                  required
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  hint="We'll send a one-time code via SMS (when enabled)"
                />
                <ErrorBox message={error} />
                <Button type="submit" disabled={loading} variant="secondary">
                  {loading ? "Sending…" : "Send OTP (if SMS enabled)"}
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
                    setOtpStep("phone");
                    setOtp("");
                    setError(null);
                  }}
                >
                  Change number
                </Button>
              </form>
            )}
          </div>
        )}
      </Card>
    </Shell>
  );
}
