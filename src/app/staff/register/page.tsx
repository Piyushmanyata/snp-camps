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

    const res = await fetch("/api/staff-register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName, email, password, invite }),
    });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error || "Failed");
      setLoading(false);
      return;
    }

    const supabase = createClient();
    await supabase.auth.signInWithPassword({ email, password });
    router.replace(json.role === "admin" ? "/admin" : "/volunteer");
    router.refresh();
  }

  return (
    <Shell
      title="Staff setup"
      subtitle="First-time account with invite code"
      backHref="/"
      roleLabel="Staff"
    >
      <Card>
        <InfoBox>
          Prefer admin to add you? Ask them from Admin → Volunteers. Otherwise
          use the invite code from your organizer.
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
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            hint="At least 6 characters"
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
            hint="Admin or volunteer code from your organizer"
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
