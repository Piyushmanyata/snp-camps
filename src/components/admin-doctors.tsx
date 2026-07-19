"use client";

import { useState, useEffect } from "react";
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

type Doctor = StaffPerson;

export function AdminDoctors({
  initial,
  canManage = true,
}: {
  initial: Doctor[];
  /** Create/delete accounts — admin only */
  canManage?: boolean;
}) {
  const router = useRouter();
  const [list, setList] = useState(initial);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setList(initial);
  }, [initial]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setOk(null);

    try {
      const res = await fetch("/api/admin/doctors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName, email, password }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        doctor?: Doctor;
      };
      if (!res.ok || !json.doctor) {
        setError(json.error || "Failed to create doctor");
        return;
      }

      setList((prev) => [
        { ...json.doctor!, phone: null, role: "doctor" },
        ...prev,
      ]);
      setOk(`Created. Share login: ${email} + the password you set.`);
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

  async function onDelete(d: Doctor) {
    const label = d.full_name || d.email || "this doctor";
    if (
      !window.confirm(
        `Delete ${label}? They will no longer be able to sign in. Patients they saw keep history (doctor name may show as blank).`,
      )
    ) {
      return;
    }
    setDeletingId(d.id);
    setError(null);
    setOk(null);
    try {
      const res = await fetch(
        `/api/admin/doctors?id=${encodeURIComponent(d.id)}`,
        { method: "DELETE" },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error || "Failed to delete doctor");
        return;
      }
      setList((prev) => prev.filter((x) => x.id !== d.id));
      if (selectedId === d.id) setSelectedId(null);
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
        Tap a doctor for KPIs and patients they saw.
      </p>
      <ul className="divide-y divide-border rounded-xl border border-border bg-white">
        {list.map((d) => {
          const open = selectedId === d.id;
          return (
            <li key={d.id}>
              <div className="flex items-center gap-2 px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => setSelectedId(open ? null : d.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="truncate font-medium text-foreground">
                    {d.full_name || "—"}
                  </p>
                  <p className="truncate text-xs text-muted">
                    {d.email || "no email"}
                    {open ? " · viewing KPIs" : " · tap for KPIs"}
                  </p>
                </button>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Badge tone="ok">doctor</Badge>
                  {canManage ? (
                    <button
                      type="button"
                      disabled={deletingId === d.id}
                      onClick={() => void onDelete(d)}
                      className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-100 disabled:opacity-50"
                    >
                      {deletingId === d.id ? "…" : "Delete"}
                    </button>
                  ) : null}
                </div>
              </div>
              {open ? (
                <div className="px-3 pb-3">
                  <StaffDetailPanel
                    person={d}
                    role="doctor"
                    onClose={() => setSelectedId(null)}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
        {!list.length ? (
          <li className="px-3 py-3">
            <EmptyState>No doctors yet — add the first below.</EmptyState>
          </li>
        ) : null}
      </ul>

      {canManage ? (
        <div className="border-t border-border pt-3">
          {!showForm ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => setShowForm(true)}
            >
              Add doctor
            </Button>
          ) : (
            <form onSubmit={onSubmit} className="space-y-3">
              <p className="text-sm text-muted">
                They sign in at <strong>Staff login</strong> and see their patient
                stats on the doctor desk.
              </p>
              <Input
                label="Full name"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
              />
              <Input
                label="Email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Input
                label="Temporary password"
                type="password"
                required
                minLength={12}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="12+ characters"
              />
              <ErrorBox message={error} />
              {ok ? (
                <p className="rounded-xl border border-green-200 bg-green-50 px-3.5 py-2.5 text-sm text-brand">
                  {ok}
                </p>
              ) : null}
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button type="submit" disabled={loading} variant="secondary">
                  {loading ? "Creating…" : "Create doctor"}
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
          {!showForm && ok ? (
            <p className="mt-2 rounded-xl border border-green-200 bg-green-50 px-3.5 py-2.5 text-sm text-brand">
              {ok}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
