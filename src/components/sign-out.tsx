"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button, ErrorBox } from "@/components/ui";

interface SignOutButtonProps {
  place?: "block" | "header";
}

export function SignOutButton({ place = "block" }: SignOutButtonProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <ErrorBox message={error} />
      <Button
        type="button"
        variant="danger"
        loading={isLoading}
        onClick={() => void signOut()}
      >
        {isLoading ? "Signing out…" : "Sign out"}
      </Button>
    </div>
  );
}
