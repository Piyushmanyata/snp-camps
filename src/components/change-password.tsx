"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button, ErrorBox, Input } from "@/components/ui";

/** Staff can set a new password after signing in with an invite password. */
export function ChangePasswordCard() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setOk(null);
    if (password.length < 12) {
      setError("Password must be at least 12 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      const supabase = createClient();
      const { error: err } = await supabase.auth.updateUser({ password });
      if (err) {
        setError(err.message);
        return;
      }
      setOk("Password updated. Use it next time you sign in.");
      setPassword("");
      setConfirm("");
      setOpen(false);
    } catch {
      setError("Could not update password. Try again.");
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <div className="rounded-xl border border-border bg-card px-3.5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-semibold text-foreground">Password</p>
            <p className="text-xs text-muted">
              Change invite password after first login
            </p>
          </div>
          <Button type="button" variant="ghost" size="sm" className="w-auto" onClick={() => setOpen(true)}>
            Change
          </Button>
        </div>
        {ok ? (
          <p
            role="status"
            aria-live="polite"
            className="mt-2 text-xs font-medium text-brand"
          >
            {ok}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form
      method="post"
      onSubmit={onSubmit}
      className="space-y-3 rounded-xl border border-border bg-card px-3.5 py-3"
    >
      <p className="text-sm font-semibold">Set a new password</p>
      <Input
        label="New password"
        type="password"
        autoComplete="new-password"
        required
        minLength={12}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        hint="At least 12 characters"
      />
      <Input
        label="Confirm password"
        type="password"
        autoComplete="new-password"
        required
        minLength={12}
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />
      <ErrorBox message={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={loading} disabled={loading} size="sm" className="w-auto">
          {loading ? "Saving…" : "Save password"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-auto"
          onClick={() => {
            setOpen(false);
            setError(null);
            setPassword("");
            setConfirm("");
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
