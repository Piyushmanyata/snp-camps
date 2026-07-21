"use client";

import { useState } from "react";
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

export default function StaffRegisterPage() {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/staff-register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName, email, password, invite }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) {
        setError(json.error || "Failed to create volunteer account");
        return;
      }

      const supabase = createClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (signInError) {
        setError(
          "Account created, but automatic sign-in failed. Use Staff login.",
        );
        return;
      }
      router.replace("/volunteer");
    } catch {
      setError("Network error. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Shell
      title="Staff setup"
      subtitle="First-time volunteer account with invite code"
      backHref="/"
      roleLabel="Staff"
    >
      <Card>
        <InfoBox>
          Preferred: admin creates you on Volunteer desk and shares an invite
          password for your email — sign in, then change password. Alternate:
          use the shared volunteer invite code below for a brand-new account.
        </InfoBox>
        <form onSubmit={onSubmit} className="mt-4 space-y-4" noValidate>
          <Input
            label="Full name"
            name="full_name"
            autoComplete="name"
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Your full name"
          />
          <Input
            label="Email"
            name="email"
            type="email"
            autoComplete="email"
            spellCheck={false}
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
          <Input
            label="Password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
              minLength={12}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            hint="At least 12 characters"
            placeholder="Choose a password"
          />
          <Input
            label="Invite code"
            name="invite"
            required
            autoComplete="off"
            spellCheck={false}
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
            hint="Volunteer code from your organizer"
            placeholder="Invite code"
          />
          <ErrorBox message={error} />
          <Button type="submit" loading={loading} disabled={loading}>
            {loading ? "Creating…" : "Create staff account"}
          </Button>
        </form>
      </Card>
    </Shell>
  );
}
