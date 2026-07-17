"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { queueLabel, queueTone } from "@/lib/types";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBox,
  Input,
  SectionTitle,
} from "@/components/ui";

export type AdminPatientRow = {
  id: string;
  reg_no: number;
  full_name: string;
  phone: string | null;
  queue_status: string;
  gender: string | null;
  age: number | null;
  created_at: string;
  camp_id: string;
  camps: { name: string } | null;
};

export function AdminPatients({ initial }: { initial: AdminPatientRow[] }) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<
    "all" | "registered" | "waiting" | "seen"
  >("all");
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter !== "all" && r.queue_status !== filter) return false;
      if (!term) return true;
      if (String(r.reg_no).includes(term)) return true;
      if (r.full_name.toLowerCase().includes(term)) return true;
      if (r.phone?.toLowerCase().includes(term)) return true;
      if (r.camps?.name?.toLowerCase().includes(term)) return true;
      return false;
    });
  }, [rows, q, filter]);

  async function removePatient(row: AdminPatientRow) {
    const ok = window.confirm(
      `Remove patient #${row.reg_no} ${row.full_name}?\nThis cannot be undone.`,
    );
    if (!ok) return;

    setDeletingId(row.id);
    setError(null);
    const supabase = createClient();
    const { error: err } = await supabase
      .from("patients")
      .delete()
      .eq("id", row.id);

    if (err) {
      setError(err.message);
      setDeletingId(null);
      return;
    }

    setRows((prev) => prev.filter((p) => p.id !== row.id));
    setDeletingId(null);
    router.refresh();
  }

  return (
    <Card>
      <SectionTitle hint={`${rows.length} total`}>All patients</SectionTitle>

      <div className="mb-3 space-y-3">
        <Input
          label="Filter list"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Name, phone, reg no, camp…"
        />
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["all", "All"],
              ["registered", "Not queued"],
              ["waiting", "In queue"],
              ["seen", "Seen"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                filter === key
                  ? "bg-brand text-white"
                  : "border border-border bg-white text-muted hover:bg-brand-soft"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <ErrorBox message={error} />

      {!filtered.length ? (
        <EmptyState>
          {rows.length === 0
            ? "No patients registered yet."
            : "No patients match this filter."}
        </EmptyState>
      ) : (
        <ul className="max-h-[28rem] divide-y divide-border overflow-y-auto">
          {filtered.map((r) => (
            <li
              key={r.id}
              className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="truncate font-semibold">
                  <span className="tabular-nums text-brand">#{r.reg_no}</span>{" "}
                  {r.full_name}
                </p>
                <p className="truncate text-xs text-muted">
                  {[
                    r.phone || null,
                    r.age != null ? `${r.age}y` : null,
                    r.gender,
                    r.camps?.name,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "—"}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <Badge tone={queueTone(r.queue_status)}>
                  {queueLabel(r.queue_status)}
                </Badge>
                <Link
                  href={`/print/${r.id}`}
                  className="rounded-lg border border-border bg-white px-2.5 py-1.5 text-sm font-semibold text-brand shadow-sm hover:bg-brand-soft"
                >
                  Print
                </Link>
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  className="w-auto"
                  disabled={deletingId === r.id}
                  onClick={() => removePatient(r)}
                >
                  {deletingId === r.id ? "…" : "Remove"}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
