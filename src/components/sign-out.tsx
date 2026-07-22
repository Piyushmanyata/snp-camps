"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button, ErrorBox, Input } from "@/components/ui";

interface SignOutButtonProps {
  place?: "block" | "header";
}

export function SignOutButton({ place = "block" }: SignOutButtonProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Password change modal state
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null);

  async function signOut() {
    setIsLoading(true);
    setError(null);

    try {
      const supabase = createClient();
      const { error: signOutError } = await supabase.auth.signOut();

      if (signOutError) {
        setError("Could not sign out. Try again.");
        return;
      }

      router.replace("/");
      router.refresh();
    } catch {
      setError("Could not sign out. Try again.");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(null);

    if (!newPassword || newPassword.length < 4) {
      setPasswordError("Password must be at least 4 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("Passwords do not match.");
      return;
    }

    setPasswordLoading(true);
    try {
      const supabase = createClient();
      const { error: err } = await supabase.auth.updateUser({
        password: newPassword,
      });

      if (err) {
        setPasswordError(err.message);
        return;
      }

      setPasswordSuccess("Password updated successfully.");
      setNewPassword("");
      setConfirmPassword("");
      setTimeout(() => {
        setShowPasswordModal(false);
        setPasswordSuccess(null);
      }, 1500);
    } catch {
      setPasswordError("Could not update password. Try again.");
    } finally {
      setPasswordLoading(false);
    }
  }

  const changePasswordBtn = (
    <button
      type="button"
      onClick={() => {
        setPasswordError(null);
        setPasswordSuccess(null);
        setNewPassword("");
        setConfirmPassword("");
        setShowPasswordModal(true);
      }}
      className="text-[11px] font-medium text-muted hover:text-foreground underline decoration-muted/40 underline-offset-2 transition"
    >
      Change password
    </button>
  );

  const passwordModal = showPasswordModal ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-5 shadow-xl sm:p-6">
        <h3 className="text-base font-bold text-foreground">Change password</h3>
        <p className="mt-1 text-xs text-muted">
          Set a new password for your account. Default is 1234.
        </p>

        <form onSubmit={handleChangePassword} className="mt-4 space-y-3">
          <Input
            label="New password"
            type="password"
            autoComplete="new-password"
            required
            minLength={4}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            hint="At least 4 characters"
          />
          <Input
            label="Confirm password"
            type="password"
            autoComplete="new-password"
            required
            minLength={4}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />

          {passwordError ? <ErrorBox message={passwordError} /> : null}
          {passwordSuccess ? (
            <p className="rounded-xl bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-200">
              {passwordSuccess}
            </p>
          ) : null}

          <div className="mt-4 flex gap-2">
            <Button
              type="submit"
              loading={passwordLoading}
              disabled={passwordLoading}
              className="flex-1"
            >
              Save password
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setShowPasswordModal(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </div>
  ) : null;

  if (place === "header") {
    return (
      <div className="flex flex-col items-end gap-1">
        {error ? (
          <p
            role="alert"
            className="max-w-[10rem] text-right text-[10px] font-medium text-red-700"
          >
            {error}
          </p>
        ) : null}
        <button
          type="button"
          disabled={isLoading}
          onClick={() => void signOut()}
          className="pressable inline-flex min-h-10 shrink-0 items-center justify-center rounded-xl bg-red-600 px-3.5 text-sm font-bold text-white shadow-sm transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isLoading ? "Signing out…" : "Sign out"}
        </button>
        {changePasswordBtn}
        {passwordModal}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-2 space-y-1">
      <ErrorBox message={error} />
      <Button
        type="button"
        variant="danger"
        loading={isLoading}
        onClick={() => void signOut()}
      >
        {isLoading ? "Signing out…" : "Sign out"}
      </Button>
      {changePasswordBtn}
      {passwordModal}
    </div>
  );
}
