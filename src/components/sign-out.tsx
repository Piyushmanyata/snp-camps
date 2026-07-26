"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button, ErrorBox } from "@/components/ui";
import { ChangePasswordDialog } from "@/components/change-password-card";

interface SignOutButtonProps {
  place?: "block" | "header";
}

export function SignOutButton({ place = "block" }: SignOutButtonProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPasswordModal, setShowPasswordModal] = useState(false);

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

  const changePasswordBtn = (
    <button
      type="button"
      onClick={() => setShowPasswordModal(true)}
      className="inline-flex min-h-12 items-center gap-1 px-1 text-xs font-semibold text-muted transition hover:text-foreground hover:underline decoration-muted/40 underline-offset-2"
    >
      <svg
        className="h-3 w-3 opacity-70"
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
      Change password
    </button>
  );

  const passwordModal = (
    <ChangePasswordDialog
      open={showPasswordModal}
      onClose={() => setShowPasswordModal(false)}
    />
  );

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
          className="pressable inline-flex min-h-12 shrink-0 items-center justify-center rounded-xl bg-red-700 px-3.5 text-sm font-bold text-white transition hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-60"
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
