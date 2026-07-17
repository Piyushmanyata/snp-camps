"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button, Card, ErrorBox, Input, Shell } from "@/components/ui";

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
    >
      <Card>
        <p className="mb-4 text-sm leading-relaxed text-muted">
          Prefer admin to add you? Ask them from the Admin → Volunteers section.
          Otherwise use the invite code from your organizer.
        </p>
        <form onSubmit={onSubmit} className="space-y-4">
          <Input
            label="Full name"
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
          />
          <Input
            label="Email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Input
            label="Password"
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Input
            label="Invite code"
            required
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
            hint="Admin or volunteer code from env"
          />
          <ErrorBox message={error} />
          <Button type="submit" disabled={loading}>
            {loading ? "Creating…" : "Create staff account"}
          </Button>
        </form>
      </Card>
    </Shell>
  );
}
