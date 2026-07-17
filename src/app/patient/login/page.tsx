"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { patientAuthEmail } from "@/lib/patient-auth";
import {
  Button,
  Card,
  ErrorBox,
  InfoBox,
  Input,
  SegmentedControl,
  Shell,
  WarningBox,
} from "@/components/ui";

const LOGIN_ERRORS: Record<string, string> = {
  invalid_qr:
    "That link is for camp staff only. Use your reg number below, or ask the desk.",
  not_found: "Patient not found. Check your registration number.",
  server: "Server is missing configuration. Ask staff to check setup.",
  account: "Could not open your account. Try again or ask the desk.",
  session: "Could not start your session. Try again.",
};

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

  const [regNo, setRegNo] = useState("");
  const [password, setPassword] = useState("");

  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [otpStep, setOtpStep] = useState<"phone" | "otp">("phone");

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("error");
    if (code && LOGIN_ERRORS[code]) setError(LOGIN_ERRORS[code]);
  }, []);

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
      setError("Enter your password (at least 6 characters).");
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
          ? "Wrong reg no or password. Ask the desk if you never set a password."
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
          " — Phone OTP needs SMS configured in Supabase. Use reg no + password for now.",
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
      subtitle="View your reg number and queue status"
      backHref="/"
      width="md"
      roleLabel="Patient"
    >
      <Card>
        <InfoBox>
          QR codes are for <strong className="text-foreground">camp staff only</strong>{" "}
          (print &amp; doctor assign). Sign in here with reg no + password.
        </InfoBox>

        <div className="mt-4 mb-4">
          <SegmentedControl
            label="Sign-in method"
            value={mode}
            onChange={(v) => {
              setMode(v);
              setError(null);
            }}
            options={[
              { value: "password", label: "Reg no + password" },
              { value: "otp", label: "Phone OTP" },
            ]}
          />
        </div>

        {mode === "password" ? (
          <form onSubmit={loginWithPassword} className="space-y-4" noValidate>
            <Input
              label="Registration number"
              name="reg_no"
              inputMode="numeric"
              required
              value={regNo}
              onChange={(e) => setRegNo(e.target.value)}
              placeholder="e.g. 1001"
              autoComplete="username"
              spellCheck={false}
              hint="On your registration slip or confirmation screen"
            />
            <Input
              label="Password"
              name="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="If set by desk or admin"
              autoComplete="current-password"
            />
            <ErrorBox message={error} />
            <Button type="submit" loading={loading} disabled={loading}>
              {loading ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        ) : (
          <div className="space-y-4">
            <WarningBox>
              Phone OTP works only after SMS is configured in Supabase. Prefer{" "}
              <strong>reg no + password</strong> for now.
            </WarningBox>
            {otpStep === "phone" ? (
              <form onSubmit={sendOtp} className="space-y-4" noValidate>
                <Input
                  label="Mobile number"
                  name="phone"
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="10-digit Indian mobile"
                  required
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  hint="We'll send a one-time code via SMS when enabled"
                />
                <ErrorBox message={error} />
                <Button
                  type="submit"
                  variant="secondary"
                  loading={loading}
                  disabled={loading}
                >
                  {loading ? "Sending…" : "Send OTP"}
                </Button>
              </form>
            ) : (
              <form onSubmit={verifyOtp} className="space-y-4" noValidate>
                <p className="rounded-xl bg-brand-soft px-3 py-2 text-sm text-brand">
                  OTP sent to <strong>{normalizePhone(phone)}</strong>
                </p>
                <Input
                  label="OTP"
                  name="otp"
                  inputMode="numeric"
                  required
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                  placeholder="6-digit code"
                  autoComplete="one-time-code"
                  spellCheck={false}
                />
                <ErrorBox message={error} />
                <Button type="submit" loading={loading} disabled={loading}>
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

      <p className="mt-4 text-center text-sm text-muted">
        New patient?{" "}
        <Link
          href="/register"
          className="font-semibold text-brand underline decoration-brand/30 underline-offset-2"
        >
          Register for camp
        </Link>
      </p>
    </Shell>
  );
}
