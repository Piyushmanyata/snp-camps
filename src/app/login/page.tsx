"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  Button,
  Card,
  ErrorBox,
  InfoBox,
  Input,
  Shell,
} from "@/components/ui";

export default function StaffLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { data: signIn, error: err } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });
    if (err) {
      const msg = err.message.toLowerCase();
      setError(
        msg.includes("invalid") || msg.includes("credentials")
          ? "Wrong email or password. Check and try again."
          : err.message,
      );
      setLoading(false);
      return;
    }

    const userId = signIn.user?.id;
    if (!userId) {
      setError("Sign-in succeeded but no user session. Try again.");
      setLoading(false);
      return;
    }

    // Must filter by user id — staff can read multiple profiles via RLS
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", userId)
      .maybeSingle();

    if (profile?.role === "admin") router.replace("/admin");
    else if (profile?.role === "volunteer") router.replace("/volunteer");
    else if (profile?.role === "doctor") router.replace("/doctor");
    else if (profile?.role === "patient") router.replace("/patient");
    else router.replace("/patient");
  }

  return (
    <Shell
      title="Staff login"
      subtitle="Admin, volunteer, and doctor access"
      backHref="/"
      width="md"
      roleLabel="Staff"
    >
      <Card>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <Input
            label="Email"
            type="email"
            name="email"
            required
            autoComplete="email"
            spellCheck={false}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
          <Input
            label="Password"
            type="password"
            name="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Your password"
          />
          <ErrorBox message={error} />
          <Button type="submit" loading={loading} disabled={loading}>
            {loading ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </Card>

      <div className="mt-4 space-y-3">
        <InfoBox>
          Need an account? Ask admin to add you, or{" "}
          <Link
            href="/staff/register"
            className="font-semibold text-brand underline decoration-brand/30 underline-offset-2"
          >
            use an invite code
          </Link>
          .
        </InfoBox>
        <p className="text-center text-sm text-muted">
          Patient?{" "}
          <Link
            href="/patient/login"
            className="font-semibold text-brand underline decoration-brand/30 underline-offset-2"
          >
            Patient login
          </Link>
        </p>
      </div>
    </Shell>
  );
}
