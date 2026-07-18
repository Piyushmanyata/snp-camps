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
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setOk(null);

    const res = await fetch("/api/admin/volunteers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName, email, password }),
    });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error || "Failed to create volunteer");
      setLoading(false);
      return;
    }

    setList((prev) => [
      {
        id: json.volunteer.id,
        full_name: json.volunteer.full_name,
        email: json.volunteer.email,
        phone: null,
        role: "volunteer",
      },
      ...prev,
    ]);
    setOk(`Created. Share login: ${email} + the password you set.`);
    setFullName("");
    setEmail("");
    setPassword("");
    setShowForm(false);
    setLoading(false);
    router.refresh();
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
    const res = await fetch(
      `/api/admin/volunteers?id=${encodeURIComponent(v.id)}`,
      { method: "DELETE" },
    );
    const json = await res.json().catch(() => ({}));
    setDeletingId(null);
    if (!res.ok) {
      setError(json.error || "Failed to delete volunteer");
      return;
    }
    setList((prev) => prev.filter((x) => x.id !== v.id));
    if (selectedId === v.id) setSelectedId(null);
    setOk(`Deleted ${label}.`);
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Tap a volunteer for KPIs and patients they registered.
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
                Create an account. They sign in at <strong>Staff login</strong>.
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
                  {loading ? "Creating…" : "Create volunteer"}
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
