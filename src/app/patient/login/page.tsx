"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { normalizePhoneE164 } from "@/lib/phone";
import { parseRegistrationNumber } from "@/lib/qr";
import { MIN_PASSWORD_LENGTH } from "@/lib/patient-password";
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
import { PhoneLinkChooser } from "@/components/phone-link-chooser";
import {
  parsePhoneLinkResult,
  type PhoneLinkCandidate,
} from "@/lib/link-patient-phone";

const LOGIN_ERRORS: Record<string, string> = {
  invalid_qr:
    "That link is for camp staff only. Use your reg number and passcode below, or ask the desk.",
  not_found: "Patient not found. Check your registration number.",
  server: "Server is missing configuration. Ask staff to check setup.",
  account: "Could not open your account. Try again or ask the desk.",
  session: "Could not start your session. Try again.",
};

type Mode = "regno" | "otp";

export default function PatientLoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("regno");

  const [regNo, setRegNo] = useState("");
  const [passcode, setPasscode] = useState("");

  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [otpStep, setOtpStep] = useState<"phone" | "otp" | "choose">("phone");
  const [phoneLinkCandidates, setPhoneLinkCandidates] = useState<
    PhoneLinkCandidate[]
  >([]);
  const [phoneLinkAskDesk, setPhoneLinkAskDesk] = useState(false);
  const [verifiedPhoneE164, setVerifiedPhoneE164] = useState<string | null>(
    null,
  );

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("error");
    if (!code || !LOGIN_ERRORS[code]) return;
    const timer = window.setTimeout(() => setError(LOGIN_ERRORS[code]), 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function loginWithRegNo(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const n = parseRegistrationNumber(regNo);
    if (n === null) {
      setError("Enter your registration number.");
      return;
    }
    const code = passcode.trim();
    if (!code || code.length < MIN_PASSWORD_LENGTH) {
      setError(
        `Enter the passcode from your desk slip (at least ${MIN_PASSWORD_LENGTH} characters).`,
      );
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/patient-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ regNo: n, passcode: code }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        // Deliberately ignore any credential fields if a misbehaving build returns them.
        password?: unknown;
        email?: unknown;
      };

      if (!res.ok || !data.ok) {
        setError(
          data.error ||
            "Invalid registration number or passcode. Check your desk slip or ask the desk.",
        );
        return;
      }

      // Session cookies are set by the route handler; hard navigation refreshes RSC.
      router.replace("/patient");
      router.refresh();
      window.location.href = "/patient";
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
            " — Phone OTP needs SMS configured in Supabase. Use reg number + passcode above, or ask the desk.",
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

      const { data: linkData, error: linkErr } = await supabase.rpc(
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

      const link = parsePhoneLinkResult(linkData);
      if (!link) {
        await supabase.auth.signOut();
        setError("Could not claim a registration for this phone number.");
        return;
      }
      if (link.status === "no_match") {
        router.replace("/register");
        return;
      }
      if (link.status === "choose") {
        setVerifiedPhoneE164(phoneE164);
        setPhoneLinkCandidates(link.candidates);
        setPhoneLinkAskDesk(link.ask_desk);
        setOtpStep("choose");
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

  async function choosePhoneLinkPatient(patientId: string) {
    setError(null);
    const phoneE164 = verifiedPhoneE164 || normalizePhoneE164(phone);
    if (!phoneE164) {
      setError("Enter a valid 10-digit Indian mobile number.");
      return;
    }
    setLoading(true);
    const supabase = createClient();
    try {
      const { data: linkData, error: linkErr } = await supabase.rpc(
        "link_patient_phone",
        { p_phone: phoneE164, p_patient_id: patientId },
      );
      if (linkErr) {
        setError(
          linkErr.message ||
            "Could not link that registration. Try again or ask the desk.",
        );
        return;
      }
      const link = parsePhoneLinkResult(linkData);
      if (link?.status === "linked") {
        router.replace("/patient");
        return;
      }
      setError("Could not link that registration. Try again or ask the desk.");
    } catch {
      setError("Could not link that registration. Check your connection.");
    } finally {
      setLoading(false);
    }
  }

  async function cancelPhoneLinkChoose() {
    setLoading(true);
    try {
      const supabase = createClient();
      await supabase.auth.signOut().catch(() => undefined);
    } finally {
      setPhoneLinkCandidates([]);
      setPhoneLinkAskDesk(false);
      setVerifiedPhoneE164(null);
      setOtpStep("phone");
      setOtp("");
      setError(null);
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
          Sign in with your <strong className="text-foreground">Registration Number</strong>{" "}
          and the <strong className="text-foreground">passcode</strong> printed on your desk
          slip. QR codes are for camp staff only.
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
              { value: "regno", label: "Reg + passcode" },
              { value: "otp", label: "Phone OTP" },
            ]}
          />
        </div>

        {mode === "regno" ? (
          <form method="post" onSubmit={loginWithRegNo} className="space-y-4">
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
              hint="Found on your registration slip"
            />
            <Input
              label="Passcode"
              name="passcode"
              type="password"
              required
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              placeholder="From your desk slip"
              autoComplete="current-password"
              spellCheck={false}
              hint="Short code printed on the desk slip — ask the desk if you lost it"
            />
            <ErrorBox message={error} />
            <Button type="submit" loading={loading} disabled={loading}>
              {loading ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        ) : (
          <div className="space-y-4">
            <WarningBox>
              Phone OTP is for self-registration when SMS is configured. If a code does not arrive, use{" "}
              <strong>Reg + passcode</strong> above or ask the camp desk.
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
            ) : otpStep === "choose" ? (
              <PhoneLinkChooser
                candidates={phoneLinkCandidates}
                askDesk={phoneLinkAskDesk}
                loading={loading}
                error={error}
                onSelect={choosePhoneLinkPatient}
                onCancel={cancelPhoneLinkChoose}
              />
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
        Lost your slip? Ask the volunteer desk to reissue a passcode.{" "}
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
