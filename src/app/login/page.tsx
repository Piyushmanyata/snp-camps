"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button, Card, ErrorBox, Input, Shell } from "@/components/ui";

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
      setError(err.message);
      setLoading(false);
      return;
    }

    const userId = signIn.user?.id;
    if (!userId) {
      setError("Sign-in succeeded but no user session.");
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
    else router.replace("/patient");
    router.refresh();
  }

  return (
    <Shell
      title="Staff login"
      subtitle="Admin and volunteer access"
      backHref="/"
      width="md"
    >
      <Card>
        <form onSubmit={onSubmit} className="space-y-4">
          <Input
            label="Email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
          <Input
            label="Password"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <ErrorBox message={error} />
          <Button type="submit" disabled={loading}>
            {loading ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </Card>
      <p className="mt-4 text-center text-sm text-muted">
        Need an account? Ask admin to add you, or{" "}
        <Link href="/staff/register" className="font-medium text-brand underline">
          use invite code
        </Link>
        .
      </p>
    </Shell>
  );
}
