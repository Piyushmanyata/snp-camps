"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button, ErrorBox } from "@/components/ui";

type Credentials = {
  regNo: number;
  password: string;
  fullName?: string | null;
  notifyNote?: string;
};

/**
 * Staff: plain sign-out.
 * Patient: re-issue password, show reg+password, notify SMS/WA stubs, then sign out.
 * place="header" → compact red control for Shell actions (top-right).
 */
export function SignOutButton({
  patientMode = false,
  place = "block",
}: {
  patientMode?: boolean;
  place?: "block" | "header";
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creds, setCreds] = useState<Credentials | null>(null);

  async function plainSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/");
    setLoading(false);
  }

  async function patientSignOut() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/patient-credentials", { method: "POST" });
      const json = (await res.json()) as {
        error?: string;
        regNo?: number;
        password?: string;
        fullName?: string;
        notify?: { sms?: string; whatsapp?: string };
        notifyConfigured?: { sms?: boolean; whatsapp?: boolean };
      };

      if (!res.ok || json.regNo == null || !json.password) {
        setError(json.error || "Could not re-issue password. Signing out…");
        const supabase = createClient();
        await supabase.auth.signOut();
        setLoading(false);
        router.replace("/patient/login");
        return;
      }

      const parts: string[] = [];
      if (json.notify?.sms === "sent") parts.push("SMS sent");
      else if (json.notifyConfigured?.sms) parts.push("SMS failed");
      else parts.push("SMS not configured yet");
      if (json.notify?.whatsapp === "sent") parts.push("WhatsApp sent");
      else if (json.notifyConfigured?.whatsapp) parts.push("WhatsApp failed");
      else parts.push("WhatsApp not configured yet");

      setCreds({
        regNo: json.regNo,
        password: json.password,
        fullName: json.fullName,
        notifyNote: parts.join(" · "),
      });

      const supabase = createClient();
      await supabase.auth.signOut();
      router.refresh();
    } catch {
      setError("Something went wrong. Try again.");
    }
    setLoading(false);
  }

  function onClick() {
    if (patientMode) void patientSignOut();
    else {
      setLoading(true);
      void plainSignOut();
    }
  }

  if (creds) {
    return (
      <div className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4">
        <p className="text-sm font-bold text-amber-950">
          Signed out — save your login
        </p>
        {creds.fullName ? (
          <p className="text-sm text-amber-900">{creds.fullName}</p>
        ) : null}
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-xl bg-white px-3 py-2 ring-1 ring-amber-200/80">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              Reg number
            </p>
            <p className="tabular text-2xl font-bold text-brand" translate="no">
              #{creds.regNo}
            </p>
          </div>
          <div className="rounded-xl bg-white px-3 py-2 ring-1 ring-amber-200/80">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              Password
            </p>
            <p
              className="font-mono text-2xl font-bold tracking-wider text-foreground"
              translate="no"
            >
              {creds.password}
            </p>
          </div>
        </div>
        <p className="text-xs text-amber-900/90">
          {creds.notifyNote ||
            "Also sent by SMS/WhatsApp when those services are configured."}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void navigator.clipboard?.writeText(
                `Reg #${creds.regNo}\nPassword: ${creds.password}`,
              );
            }}
          >
            Copy login
          </Button>
          <Link
            href="/patient/login"
            className="pressable inline-flex min-h-12 flex-1 items-center justify-center rounded-xl bg-brand px-4 text-sm font-semibold text-white shadow-sm hover:bg-brand-dark"
          >
            Sign in again
          </Link>
        </div>
      </div>
    );
  }

  if (place === "header") {
    return (
      <div className="flex flex-col items-end gap-1">
        {error ? (
          <p className="max-w-[10rem] text-right text-[10px] font-medium text-red-700">
            {error}
          </p>
        ) : null}
        <button
          type="button"
          disabled={loading}
          onClick={onClick}
          className="pressable inline-flex min-h-10 shrink-0 items-center justify-center rounded-xl bg-red-600 px-3.5 text-sm font-bold text-white shadow-sm transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading
            ? patientMode
              ? "…"
              : "…"
            : "Sign out"}
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
        loading={loading}
        disabled={loading}
        onClick={onClick}
      >
        {loading
          ? patientMode
            ? "Preparing credentials…"
            : "Signing out…"
          : "Sign out"}
      </Button>
    </div>
  );
}
