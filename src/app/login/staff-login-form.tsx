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
import { mapAuthError } from "@/lib/public-error";
import { roleHome } from "@/lib/roles";

export function StaffLoginForm() {
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
    try {
      const { data: signIn, error: err } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (err) {
        setError(
          mapAuthError(err, {
            kind: "sign-in",
            context: "login.sign-in",
          }),
        );
        return;
      }

      const userId = signIn.user?.id;
      if (!userId) {
        setError("Sign-in succeeded but no user session. Try again.");
        return;
      }

      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("role, disabled_at")
        .eq("id", userId)
        .maybeSingle();

      if (profileError || !profile || (profile as { disabled_at?: string | null }).disabled_at) {
        await supabase.auth.signOut();
        setError("This staff account is unavailable. Ask an admin for help.");
        return;
      }

      const home = roleHome(profile.role);
      if (home) router.replace(home);
      else {
        // Residual/non-staff profiles cannot use staff login (#59).
        await supabase.auth.signOut();
        setError(
          "This account is not staff login. Use camp crew credentials, or ask an admin for access.",
        );
      }
    } catch {
      setError("Could not sign in. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Shell
      title="Staff login"
      subtitle="Admin and camp staff access"
      backHref="/"
      width="md"
      roleLabel="Staff"
    >
      <Card>
        <form method="post" onSubmit={onSubmit} className="space-y-4">
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
          Need an account? Ask an admin to create one for you. Patients do not
          sign in — they register at the camp desk or via self-registration,
          and the desk looks them up by name or Aadhaar re-scan.
        </InfoBox>
        <p className="text-center text-sm text-muted">
          <Link
            href="/"
            className="font-semibold text-brand underline decoration-brand/30 underline-offset-2"
          >
            Back to home
          </Link>
        </p>
      </div>
    </Shell>
  );
}
