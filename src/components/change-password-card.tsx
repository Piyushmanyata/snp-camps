"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  isPasswordLongEnough,
  MIN_PASSWORD_LENGTH,
} from "@/lib/patient-password";
import { mapAuthError } from "@/lib/public-error";
import {
  Button,
  Card,
  ErrorBox,
  Input,
  SectionTitle,
  SuccessBox,
} from "@/components/ui";

type ChangePasswordFormProps = {
  onSuccess?: () => void;
  /** Compact layout for dialogs. */
  compact?: boolean;
};

export function ChangePasswordForm({
  onSuccess,
  compact = false,
}: ChangePasswordFormProps) {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!newPassword || !isPasswordLongEnough(newPassword)) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
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
        setError(
          mapAuthError(err, {
            kind: "change-password",
            context: "change-password",
          }),
        );
        return;
      }

      setSuccess("Password updated successfully.");
      setNewPassword("");
      setConfirmPassword("");
      onSuccess?.();
    } catch {
      setError("Could not update password. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className={compact ? "mt-4 space-y-3" : "mt-3 space-y-3"}>
      <Input
        label="New password"
        type="password"
        autoComplete="new-password"
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        hint={`At least ${MIN_PASSWORD_LENGTH} characters`}
        minLength={MIN_PASSWORD_LENGTH}
        required
      />
      <Input
        label="Confirm new password"
        type="password"
        autoComplete="new-password"
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        minLength={MIN_PASSWORD_LENGTH}
        required
      />
      <ErrorBox message={error} />
      {success ? (
        compact ? (
          <p className="rounded-xl bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-200">
            {success}
          </p>
        ) : (
          <SuccessBox message={success} />
        )
      ) : null}
      <Button
        type="submit"
        variant={compact ? undefined : "secondary"}
        size={compact ? undefined : "sm"}
        loading={loading}
        disabled={loading}
        className={compact ? "w-full" : undefined}
      >
        Save password
      </Button>
    </form>
  );
}

export function ChangePasswordCard() {
  return (
    <Card padding="sm" id="change-password">
      <SectionTitle hint="Update your account login password">
        Change password
      </SectionTitle>
      <ChangePasswordForm />
    </Card>
  );
}

type ChangePasswordDialogProps = {
  open: boolean;
  onClose: () => void;
};

/** Modal wrapper around the shared change-password form (header / sign-out). */
export function ChangePasswordDialog({
  open,
  onClose,
}: ChangePasswordDialogProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 animate-in fade-in duration-200"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-5 sm:p-6">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand-soft text-brand">
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 0121 9z"
              />
            </svg>
          </div>
          <h3 className="text-base font-bold text-foreground">Change password</h3>
        </div>
        <p className="mt-1.5 text-xs text-muted">
          Update the login password for your account. Next time you sign in, use
          your new password.
        </p>

        <ChangePasswordForm
          compact
          onSuccess={() => {
            setTimeout(() => onClose(), 1500);
          }}
        />

        <div className="mt-3">
          <Button type="button" variant="secondary" onClick={onClose} className="w-full">
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
