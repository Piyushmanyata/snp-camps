"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button, Card, ErrorBox, Input, SectionTitle, SuccessBox } from "@/components/ui";

export function ChangePasswordCard() {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!newPassword || newPassword.length < 4) {
      setError("Password must be at least 4 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    try {
      const supabase = createClient();
      const { error: err } = await supabase.auth.updateUser({
        password: newPassword,
      });

      if (err) {
        setError(err.message);
        return;
      }

      setSuccess("Password updated successfully.");
      setNewPassword("");
      setConfirmPassword("");
    } catch {
      setError("Could not update password. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card padding="sm" id="change-password">
      <SectionTitle hint="Update your account login password">
        Change password
      </SectionTitle>
      <form onSubmit={handleSubmit} className="mt-3 space-y-3">
        <Input
          label="New password"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder="At least 4 characters"
          required
        />
        <Input
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder="Repeat new password"
          required
        />
        <ErrorBox message={error} />
        <SuccessBox message={success} />
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          loading={loading}
          disabled={loading}
        >
          Save password
        </Button>
      </form>
    </Card>
  );
}
