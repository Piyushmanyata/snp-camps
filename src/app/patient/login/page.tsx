"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { patientAuthEmail } from "@/lib/patient-auth";
import { normalizePhoneE164 } from "@/lib/phone";
import { parseRegistrationNumber } from "@/lib/qr";
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
    if (!code || !LOGIN_ERRORS[code]) return;
    const timer = window.setTimeout(() => setError(LOGIN_ERRORS[code]), 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function loginWithPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const n = parseRegistrationNumber(regNo);
    if (n === null) {
      setError("Enter your registration number.");
      return;
    }
    if (password.length < 6) {
      setError("Enter your password (at least 6 characters).");
      return;
    }

    setLoading(true);
    try {
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
        return;
      }

      router.replace("/patient");
    } catch {
      setError("Could not sign in. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  async function sendOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const phoneE164 = normalizePhoneE164(phone);
    if (!phoneE164) {
      setError("Enter a valid 10-digit Indian mobile number.");
      return;
    }

    setLoading(true);
    try {
      const supabase = createClient();
      const { error: err } = await supabase.auth.signInWithOtp({
        phone: phoneE164,
        options: { shouldCreateUser: true },
      });
      if (err) {
        setError(
          err.message +
            " — Phone OTP needs SMS configured in Supabase. Use reg no + password for now.",
        );
        return;
      }
      setOtpStep("otp");
    } catch {
      setError("Could not send an OTP. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  async function verifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const phoneE164 = normalizePhoneE164(phone);
    if (!phoneE164) {
      setError("Enter a valid 10-digit Indian mobile number.");
      return;
    }

    setLoading(true);
    const supabase = createClient();
    try {
      const {
        data: { user },
        error: err,
      } = await supabase.auth.verifyOtp({
        phone: phoneE164,
        token: otp,
        type: "sms",
      });
      if (err) {
        setError(err.message);
        return;
      }

      if (!user) {
        setError("OTP verified but no user session was created. Try again.");
        return;
      }

      const { data: linked, error: linkedError } = await supabase
        .from("patients")
        .select("id")
        .eq("user_id", user.id)
        .limit(1)
        .maybeSingle();

      if (linkedError) {
        await supabase.auth.signOut();
        setError("Could not check your linked registrations. Try again.");
        return;
      }

      if (linked) {
        router.replace("/patient");
        return;
      }

      const { data: linkedId, error: linkErr } = await supabase.rpc(
        "link_patient_phone",
        { p_phone: phoneE164 },
      );
      if (linkErr) {
        await supabase.auth.signOut();
        setError(
          linkErr?.message ||
            "Could not claim a registration for this phone number.",
        );
        return;
      }

      if (!linkedId) {
        router.replace("/register");
        return;
      }

      router.replace("/patient");
    } catch {
      await supabase.auth.signOut().catch(() => undefined);
      setError("Could not verify the OTP. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
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
          Use the <strong className="text-foreground">reg number and password</strong>{" "}
          from registration (also sent by SMS/WhatsApp when configured). Save the
          one-time backup password when it is shown; it is not displayed again
          after sign out. QR codes are for camp staff only.
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
          <form method="post" onSubmit={loginWithPassword} className="space-y-4">
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
              Phone OTP requires SMS delivery. If a code does not arrive, use{" "}
              <strong>reg no + password</strong> or ask the camp desk.
            </WarningBox>
            {otpStep === "phone" ? (
              <form method="post" onSubmit={sendOtp} className="space-y-4">
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
              <form method="post" onSubmit={verifyOtp} className="space-y-4">
                <p className="rounded-xl bg-brand-soft px-3 py-2 text-sm text-brand">
                  OTP sent to <strong>{normalizePhoneE164(phone) || phone}</strong>
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
