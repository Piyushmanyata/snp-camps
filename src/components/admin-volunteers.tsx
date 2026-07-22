"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBox,
  Input,
  SuccessBox,
} from "@/components/ui";
import {
  StaffDetailPanel,
  type StaffPerson,
} from "@/components/staff-detail";

type Volunteer = StaffPerson;

type CredentialShare = {
  id: string;
  email: string;
  password: string;
  name: string;
};

export function AdminVolunteers({
  initial,
  canManage = true,
}: {
  initial: Volunteer[];
  canManage?: boolean;
}) {
  const router = useRouter();
  const [list, setList] = useState(initial);
  const [prevInitial, setPrevInitial] = useState(initial);
  if (initial !== prevInitial) {
    setPrevInitial(initial);
    setList(initial);
  }
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [credential, setCredential] = useState<CredentialShare | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [reactivatingId, setReactivatingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const credentialHeadingRef = useRef<HTMLHeadingElement>(null);
  const busy =
    loading ||
    deletingId !== null ||
    resettingId !== null ||
    reactivatingId !== null ||
    credential !== null;

  useEffect(() => {
    if (credential) credentialHeadingRef.current?.focus();
  }, [credential]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setLoading(true);
    setError(null);
    setOk(null);

    try {
      const res = await fetch("/api/admin/volunteers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName, email }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        volunteer?: Volunteer;
        temporaryPassword?: string;
      };
      if (!res.ok || !json.volunteer || !json.temporaryPassword) {
        setError(json.error || "Failed to create volunteer");
        return;
      }

      setList((prev) => [
        { ...json.volunteer!, phone: null, role: "volunteer" },
        ...prev,
      ]);
      setCredential({
        id: json.volunteer.id,
        email: json.volunteer.email || email,
        password: json.temporaryPassword,
        name: json.volunteer.full_name || fullName,
      });
      setOk("Volunteer created. Share the temporary password below (shown once).");
      setFullName("");
      setEmail("");
      setShowForm(false);
      router.refresh();
    } catch {
      setError("Network error. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  async function copyCredential() {
    if (!credential) return;
    const text = [
      `SNP Camps volunteer login`,
      `Name: ${credential.name}`,
      `Email: ${credential.email}`,
      `Temporary password: ${credential.password}`,
      `Sign in: ${window.location.origin}/login`,
      `Change this password after signing in.`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setError(null);
      setOk("Login details copied.");
    } catch {
      setCopied(false);
      setError("Could not copy — select the password manually.");
    }
  }

  async function onReset(v: Volunteer) {
    if (busy) return;
    const label = v.full_name || v.email || "this volunteer";
    if (
      !window.confirm(
        `Reset the temporary password for ${label}? Their current password will stop working immediately.`,
      )
    ) {
      return;
    }

    setResettingId(v.id);
    setError(null);
    setOk(null);
    try {
      const res = await fetch("/api/admin/volunteers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: v.id, action: "reset_password" }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        temporaryPassword?: string;
        volunteer?: Pick<Volunteer, "id" | "full_name" | "email">;
      };
      if (!res.ok || !json.temporaryPassword) {
        setError(json.error || "Failed to reset volunteer password");
        return;
      }

      setCredential({
        id: v.id,
        email: json.volunteer?.email || v.email || "",
        password: json.temporaryPassword,
        name: json.volunteer?.full_name || v.full_name || "Volunteer",
      });
      setOk("Temporary password reset. Share it below (shown once).");
    } catch {
      setError("Network error. Check your connection and try again.");
    } finally {
      setResettingId(null);
    }
  }

  async function onReactivate(v: Volunteer) {
    if (busy || !v.disabled_at) return;
    const label = v.full_name || v.email || "this volunteer";
    if (!window.confirm(`Reactivate ${label}? They will be able to sign in again.`)) {
      return;
    }

    setReactivatingId(v.id);
    setError(null);
    setOk(null);
    try {
      const res = await fetch("/api/admin/volunteers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: v.id, action: "reactivate" }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        volunteer?: Volunteer;
      };
      if (!res.ok || !json.volunteer) {
        setError(json.error || "Failed to reactivate volunteer");
        return;
      }
      setList((prev) =>
        prev.map((volunteer) =>
          volunteer.id === v.id
            ? { ...volunteer, ...json.volunteer, disabled_at: null }
            : volunteer,
        ),
      );
      setOk(`Reactivated ${label}.`);
      router.refresh();
    } catch {
      setError("Network error. Check your connection and try again.");
    } finally {
      setReactivatingId(null);
    }
  }

  async function onDelete(v: Volunteer) {
    if (busy) return;
    const label = v.full_name || v.email || "this volunteer";
    if (
      !window.confirm(
        `Deactivate ${label}? They will no longer be able to sign in. Their activity history will be preserved.`,
      )
    ) {
      return;
    }
    setDeletingId(v.id);
    setError(null);
    setOk(null);
    try {
      const res = await fetch(
        `/api/admin/volunteers?id=${encodeURIComponent(v.id)}`,
        { method: "DELETE" },
      );
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        disabledAt?: string;
      };
      if (!res.ok) {
        setError(json.error || "Failed to deactivate volunteer");
        return;
      }
      setList((prev) =>
        prev.map((volunteer) =>
          volunteer.id === v.id
            ? { ...volunteer, disabled_at: json.disabledAt || new Date().toISOString() }
            : volunteer,
        ),
      );
      if (selectedId === v.id) setSelectedId(null);
      setOk(`Deactivated ${label}.`);
      router.refresh();
    } catch {
      setError("Network error. Check your connection and try again.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Create a volunteer with name + email. A temporary password is generated
        for you to share once. Tap a name for KPIs.
      </p>
      <p
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {loading
          ? "Creating volunteer account."
          : resettingId
            ? "Resetting volunteer password."
            : reactivatingId
              ? "Reactivating volunteer account."
            : deletingId
              ? "Deactivating volunteer account."
              : ""}
      </p>
      <ErrorBox message={error} />
      <SuccessBox message={ok} />
      <ul className="divide-y divide-border rounded-xl border border-border bg-white">
        {list.map((v) => {
          const open = selectedId === v.id;
          return (
            <li key={v.id}>
              <div className="flex flex-col items-stretch gap-2 px-3 py-2.5 sm:flex-row sm:items-center">
                <button
                  id={`staff-detail-trigger-${v.id}`}
                  type="button"
                  onClick={() => setSelectedId(open ? null : v.id)}
                  aria-expanded={open}
                  aria-controls={`volunteer-detail-${v.id}`}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="truncate font-medium text-foreground">
                    {v.full_name || "—"}
                  </p>
                  <p className="truncate text-xs text-muted">
                    {v.email || "no email"}
                    {v.disabled_at ? " · disabled" : open ? " · viewing KPIs" : " · tap for KPIs"}
                  </p>
                </button>
                <div className="flex w-full shrink-0 flex-wrap items-center justify-end gap-1.5 sm:w-auto">
                  <Badge tone="ok">volunteer</Badge>
                  {v.disabled_at ? <Badge tone="danger">disabled</Badge> : null}
                  {canManage ? (
                    v.disabled_at ? (
                      <button
                        type="button"
                        disabled={busy}
                        aria-busy={reactivatingId === v.id || undefined}
                        onClick={() => void onReactivate(v)}
                        className="pressable min-h-11 rounded-lg border border-brand/25 bg-brand-soft px-2.5 py-1.5 text-xs font-semibold text-brand transition hover:bg-white disabled:opacity-50"
                      >
                        {reactivatingId === v.id ? "Reactivating…" : "Reactivate"}
                      </button>
                    ) : (
                      <>
                      <button
                        type="button"
                        disabled={busy}
                        aria-busy={resettingId === v.id || undefined}
                        onClick={() => void onReset(v)}
                        className="pressable min-h-11 rounded-lg border border-border bg-brand-soft px-2.5 py-1.5 text-xs font-semibold text-brand transition hover:bg-white disabled:opacity-50"
                      >
                        {resettingId === v.id ? "Resetting…" : "Reset password"}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        aria-busy={deletingId === v.id || undefined}
                        onClick={() => void onDelete(v)}
                        className="pressable min-h-11 rounded-lg border border-danger/20 bg-danger-soft px-2.5 py-1.5 text-xs font-semibold text-danger transition hover:bg-danger/10 disabled:opacity-50"
                      >
                        {deletingId === v.id ? "Deactivating…" : "Deactivate"}
                      </button>
                      </>
                    )
                  ) : null}
                </div>
              </div>
              {open ? (
                <div id={`volunteer-detail-${v.id}`} className="px-3 pb-3">
                  <StaffDetailPanel
                    person={v}
                    role="volunteer"
                    onClose={() => setSelectedId(null)}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
        {!list.length ? (
          <li className="px-3 py-3">
            <EmptyState>No volunteers yet — add the first below.</EmptyState>
          </li>
        ) : null}
      </ul>

      {credential ? (
        <section
          aria-labelledby="volunteer-credential-heading"
          className="rounded-2xl border border-brand/25 bg-brand-soft/40 p-4"
        >
          <h3
            id="volunteer-credential-heading"
            ref={credentialHeadingRef}
            tabIndex={-1}
            className="text-sm font-bold text-brand"
          >
            Share temporary login (shown once)
          </h3>
          <p className="mt-1 text-xs text-muted">
            Copy these details before dismissing them. The password cannot be
            retrieved again; reset it if another copy is needed.
          </p>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-muted">Email</dt>
              <dd className="break-all font-semibold">{credential.email}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-muted">Temporary password</dt>
              <dd className="break-all font-mono font-bold tracking-wide text-brand">
                {credential.password}
              </dd>
            </div>
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              className="sm:w-auto"
              onClick={() => void copyCredential()}
            >
              {copied ? "Copied" : "Copy login details"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="sm:w-auto"
              onClick={() => {
                if (
                  window.confirm(
                    "Have you securely saved or shared this temporary password?",
                  )
                ) {
                  setCredential(null);
                  setCopied(false);
                }
              }}
            >
              Dismiss
            </Button>
          </div>
        </section>
      ) : null}

      {canManage ? (
        <div className="border-t border-border pt-3">
          {!showForm ? (
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              aria-expanded={showForm}
              aria-controls="volunteer-create-form"
              onClick={() => {
                setShowForm(true);
                setError(null);
                setOk(null);
              }}
            >
              Register new volunteer
            </Button>
          ) : (
            <form id="volunteer-create-form" onSubmit={onSubmit} className="space-y-3">
              <p className="text-sm text-muted">
                A secure temporary password is generated after creation and
                shown only once. They sign in at <strong>Staff login</strong>.
              </p>
              <Input
                label="Full name"
                required
                disabled={busy}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Volunteer name"
              />
              <Input
                label="Email"
                type="email"
                required
                disabled={busy}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="volunteer@example.com"
                hint="Must stay the same — they sign in with this email"
              />
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button type="submit" loading={loading} disabled={busy} variant="secondary">
                  Create volunteer & get password
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setShowForm(false);
                    setError(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </div>
      ) : null}
    </div>
  );
}
