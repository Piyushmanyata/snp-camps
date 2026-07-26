"use client";

import { useState, type FormEvent } from "react";
import { Button, ErrorBox, Input, SuccessBox } from "@/components/ui";

type FailureRow = {
  at: string;
  template: string;
  detail: string;
  phoneLast4?: string;
};

type StatusPayload = {
  configured: boolean;
  failures: FailureRow[];
  sampleMaxLengthChars?: number;
};

async function loadSmsStatus(): Promise<
  | { ok: true; configured: boolean; failures: FailureRow[] }
  | { ok: false }
> {
  try {
    const res = await fetch("/api/admin/test-sms", { cache: "no-store" });
    if (!res.ok) return { ok: false };
    const data = (await res.json()) as StatusPayload;
    return {
      ok: true,
      configured: Boolean(data.configured),
      failures: Array.isArray(data.failures) ? data.failures : [],
    };
  } catch {
    return { ok: false };
  }
}

export function AdminTestSms() {
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [statusLoading, setStatusLoading] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [failures, setFailures] = useState<FailureRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  async function refresh() {
    setStatusLoading(true);
    setError(null);
    const result = await loadSmsStatus();
    if (!result.ok) {
      setError("Could not load SMS status.");
      setStatusLoading(false);
      return;
    }
    setConfigured(result.configured);
    setFailures(result.failures);
    setStatusLoading(false);
  }

  async function onSend(e: FormEvent) {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    setError(null);
    setFlash(null);
    try {
      const res = await fetch("/api/admin/test-sms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        detail?: string;
        status?: string;
        requestId?: string;
      };
      if (!res.ok || !data.ok) {
        setError(
          data.error ||
            data.detail ||
            "Test SMS failed. Check MSG91 env and DLT template.",
        );
        await refresh();
        setLoading(false);
        return;
      }
      setFlash(
        data.requestId
          ? `Test SMS sent (request ${data.requestId}).`
          : "Test SMS sent.",
      );
      await refresh();
    } catch {
      setError("Test SMS failed. Check the internet and try again.");
    }
    setLoading(false);
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Sends the real registration Hinglish template via MSG91 so you can
        verify DLT before camp day. Desk registration never waits on SMS.
      </p>
      <p className="text-sm">
        Provider:{" "}
        <span className="font-semibold text-foreground">
          {statusLoading
            ? "…"
            : configured == null
              ? "tap Refresh status"
              : configured
                ? "MSG91 configured"
                : "not configured (set MSG91_* env vars)"}
        </span>
      </p>

      <form onSubmit={onSend} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <Input
            id="admin-test-sms-phone"
            label="Mobile number"
            inputMode="tel"
            autoComplete="tel"
            placeholder="9876543210"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            disabled={loading}
          />
        </div>
        <Button type="submit" disabled={loading || !phone.trim()}>
          {loading ? "Sending…" : "Send test SMS"}
        </Button>
      </form>

      <ErrorBox message={error} />
      <SuccessBox message={flash} />

      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-foreground">
            Recent SMS failures
          </p>
          <button
            type="button"
            className="pressable min-h-12 min-w-12 rounded-lg px-3 py-2 text-sm font-semibold text-brand hover:bg-brand-soft disabled:opacity-50"
            onClick={() => void refresh()}
            disabled={statusLoading}
          >
            {statusLoading ? "Loading…" : "Refresh status"}
          </button>
        </div>
        {configured == null && !statusLoading ? (
          <p className="text-sm text-muted">
            Press Refresh status to load MSG91 config and recent failures.
          </p>
        ) : failures.length === 0 ? (
          <p className="text-sm text-muted">No failures recorded in this process.</p>
        ) : (
          <ul className="max-h-48 space-y-1 overflow-y-auto text-xs text-muted">
            {failures
              .slice()
              .reverse()
              .map((f, i) => (
                <li
                  key={`${f.at}-${i}`}
                  className="rounded border border-border bg-card px-2 py-1 font-mono"
                >
                  <span className="text-foreground">{f.at}</span>
                  {" · "}
                  {f.template}
                  {f.phoneLast4 ? ` · …${f.phoneLast4}` : ""}
                  {": "}
                  {f.detail}
                </li>
              ))}
          </ul>
        )}
        <p className="mt-1 text-[0.6875rem] text-muted">
          Shows durable failed/ambiguous rows from the SMS ledger (survives
          redeploy). Host logs still record{" "}
          <code className="font-mono">[sms-failure]</code>.
        </p>
      </div>
    </div>
  );
}
