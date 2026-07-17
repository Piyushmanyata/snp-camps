"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBox,
  Input,
  SectionTitle,
} from "@/components/ui";

type Doctor = {
  id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  role: string;
  created_at?: string;
};

export function AdminDoctors({ initial }: { initial: Doctor[] }) {
  const router = useRouter();
  const [list, setList] = useState(initial);
  const [prevInitial, setPrevInitial] = useState(initial);
  if (initial !== prevInitial) {
    setPrevInitial(initial);
    setList(initial);
  }
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setOk(null);

    const res = await fetch("/api/admin/doctors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName, email, password }),
    });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error || "Failed to create doctor");
      setLoading(false);
      return;
    }

    setList((prev) => [
      {
        id: json.doctor.id,
        full_name: json.doctor.full_name,
        email: json.doctor.email,
        phone: null,
        role: "doctor",
      },
      ...prev,
    ]);
    setOk(`Created. Share login: ${email} + the password you set.`);
    setFullName("");
    setEmail("");
    setPassword("");
    setLoading(false);
    router.refresh();
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
    const res = await fetch(
      `/api/admin/doctors?id=${encodeURIComponent(d.id)}`,
      { method: "DELETE" },
    );
    const json = await res.json().catch(() => ({}));
    setDeletingId(null);
    if (!res.ok) {
      setError(json.error || "Failed to delete doctor");
      return;
    }
    setList((prev) => prev.filter((x) => x.id !== d.id));
    setOk(`Deleted ${label}.`);
    router.refresh();
  }

  return (
    <Card>
      <SectionTitle hint={`${list.length} total`}>Doctors</SectionTitle>
      <ul className="mb-4 divide-y divide-border">
        {list.map((d) => (
          <li
            key={d.id}
            className="flex items-center justify-between gap-2 py-2.5"
          >
            <div className="min-w-0">
              <p className="truncate font-medium">{d.full_name || "—"}</p>
              <p className="truncate text-xs text-muted">
                {d.email || "no email"}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Badge tone="ok">doctor</Badge>
              <button
                type="button"
                disabled={deletingId === d.id}
                onClick={() => void onDelete(d)}
                className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-100 disabled:opacity-50"
              >
                {deletingId === d.id ? "…" : "Delete"}
              </button>
            </div>
          </li>
        ))}
        {!list.length ? (
          <li className="py-2">
            <EmptyState>No doctors yet — add the first below.</EmptyState>
          </li>
        ) : null}
      </ul>

      <form onSubmit={onSubmit} className="space-y-3 border-t border-border pt-4">
        <p className="text-sm text-muted">
          Only admins can create doctors. They sign in at{" "}
          <strong>Staff login</strong> and see their patient stats.
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
          type="text"
          required
          minLength={6}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="min 6 characters"
        />
        <ErrorBox message={error} />
        {ok ? (
          <p className="rounded-xl border border-green-200 bg-green-50 px-3.5 py-2.5 text-sm text-brand">
            {ok}
          </p>
        ) : null}
        <Button type="submit" disabled={loading} variant="secondary">
          {loading ? "Creating…" : "Add doctor"}
        </Button>
      </form>
    </Card>
  );
}
