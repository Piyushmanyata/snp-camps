"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBox,
  Input,
} from "@/components/ui";
import {
  StaffDetailPanel,
  type StaffPerson,
} from "@/components/staff-detail";

type Volunteer = StaffPerson;

type InviteShare = {
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
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [invite, setInvite] = useState<InviteShare | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setOk(null);
    setInvite(null);
    setCopied(false);

    try {
      const res = await fetch("/api/admin/volunteers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName,
          email,
          password: password.trim() || undefined,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        volunteer?: Volunteer;
        invitePassword?: string;
      };
      if (!res.ok || !json.volunteer || !json.invitePassword) {
        setError(json.error || "Failed to create volunteer");
        return;
      }

      setList((prev) => [
        { ...json.volunteer!, phone: null, role: "volunteer" },
        ...prev,
      ]);
      setInvite({
        email: json.volunteer.email || email,
        password: json.invitePassword,
        name: json.volunteer.full_name || fullName,
      });
      setOk("Volunteer created. Share the invite password below (shown once).");
      setFullName("");
      setEmail("");
      setPassword("");
      setShowForm(false);
      router.refresh();
    } catch {
      setError("Network error. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  async function copyInvite() {
    if (!invite) return;
    const text = [
      `SNP Camps volunteer login`,
      `Name: ${invite.name}`,
      `Email: ${invite.email}`,
      `Invite password: ${invite.password}`,
      `Sign in: ${typeof window !== "undefined" ? window.location.origin : ""}/login`,
      `You can change the password after signing in.`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setError("Could not copy — select the password manually.");
    }
  }

  async function onDelete(v: Volunteer) {
    const label = v.full_name || v.email || "this volunteer";
    if (
      !window.confirm(
        `Delete ${label}? They will no longer be able to sign in.`,
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
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error || "Failed to delete volunteer");
        return;
      }
      setList((prev) => prev.filter((x) => x.id !== v.id));
      if (selectedId === v.id) setSelectedId(null);
      setOk(`Deleted ${label}.`);
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
        Create a volunteer with name + email. Share their invite password so they
        can sign in (same email). They can change the password later. Tap a name
        for KPIs.
      </p>
      <ul className="divide-y divide-border rounded-xl border border-border bg-white">
        {list.map((v) => {
          const open = selectedId === v.id;
          return (
            <li key={v.id}>
              <div className="flex items-center gap-2 px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => setSelectedId(open ? null : v.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="truncate font-medium text-foreground">
                    {v.full_name || "—"}
                  </p>
                  <p className="truncate text-xs text-muted">
                    {v.email || "no email"}
                    {open ? " · viewing KPIs" : " · tap for KPIs"}
                  </p>
                </button>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Badge tone="ok">volunteer</Badge>
                  {canManage ? (
                    <button
                      type="button"
                      disabled={deletingId === v.id}
                      onClick={() => void onDelete(v)}
                      className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-100 disabled:opacity-50"
                    >
                      {deletingId === v.id ? "…" : "Delete"}
                    </button>
                  ) : null}
                </div>
              </div>
              {open ? (
                <div className="px-3 pb-3">
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

      {invite ? (
        <div className="rounded-2xl border border-brand/25 bg-brand-soft/40 p-4">
          <p className="text-sm font-bold text-brand">Share invite (once)</p>
          <p className="mt-1 text-xs text-muted">
            {invite.name} signs in with this email + invite password, then can
            change password on their desk.
          </p>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-muted">Email</dt>
              <dd className="font-semibold break-all">{invite.email}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-muted">Invite password</dt>
              <dd className="font-mono font-bold tracking-wide text-brand break-all">
                {invite.password}
              </dd>
            </div>
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" variant="secondary" onClick={() => void copyInvite()}>
              {copied ? "Copied" : "Copy share text"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setInvite(null);
                setCopied(false);
              }}
            >
              Dismiss
            </Button>
          </div>
        </div>
      ) : null}

      {canManage ? (
        <div className="border-t border-border pt-3">
          {!showForm ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => setShowForm(true)}
            >
              Register new volunteer
            </Button>
          ) : (
            <form onSubmit={onSubmit} className="space-y-3">
              <p className="text-sm text-muted">
                Leave password blank to auto-generate an invite password you can
                share. They sign in at <strong>Staff login</strong> with the same
                email.
              </p>
              <Input
                label="Full name"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Volunteer name"
              />
              <Input
                label="Email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="volunteer@example.com"
                hint="Must stay the same — they sign in with this email"
              />
              <Input
                label="Invite password (optional)"
                type="password"
                minLength={12}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Leave blank to auto-generate"
                hint="12+ characters if set; blank = shareable auto password"
              />
              <ErrorBox message={error} />
              {ok ? (
                <p className="rounded-xl border border-green-200 bg-green-50 px-3.5 py-2.5 text-sm text-brand">
                  {ok}
                </p>
              ) : null}
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button type="submit" disabled={loading} variant="secondary">
                  {loading ? "Creating…" : "Create & get invite"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
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
          {!showForm ? <ErrorBox message={error} /> : null}
          {!showForm && ok && !invite ? (
            <p className="mt-2 rounded-xl border border-green-200 bg-green-50 px-3.5 py-2.5 text-sm text-brand">
              {ok}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}