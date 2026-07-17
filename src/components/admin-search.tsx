"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  SectionTitle,
} from "@/components/ui";

type Row = {
  id: string;
  reg_no: number;
  full_name: string;
  phone: string | null;
  queue_status: string;
};

export function AdminSearch() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const supabase = createClient();
    const term = q.trim();
    let query = supabase
      .from("patients")
      .select("id, reg_no, full_name, phone, queue_status")
      .order("created_at", { ascending: false })
      .limit(30);

    if (term) {
      if (/^\d+$/.test(term)) {
        query = query.or(`reg_no.eq.${term},phone.ilike.%${term}%`);
      } else {
        query = query.or(`full_name.ilike.%${term}%,phone.ilike.%${term}%`);
      }
    }

    const { data } = await query;
    setRows((data as Row[]) || []);
    setLoading(false);
  }

  return (
    <Card>
      <SectionTitle>Search patients</SectionTitle>
      <form onSubmit={search} className="mb-3 flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Input
            label="Name, phone, or reg no"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search…"
          />
        </div>
        <Button
          type="submit"
          className="w-auto min-w-[4.5rem] shrink-0"
          disabled={loading}
        >
          {loading ? "…" : "Go"}
        </Button>
      </form>
      {rows === null ? (
        <p className="text-xs text-muted">Search to list recent patients.</p>
      ) : rows.length === 0 ? (
        <EmptyState>No matches.</EmptyState>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex items-center justify-between gap-2 py-2.5"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">
                  <span className="tabular-nums text-brand">#{r.reg_no}</span>{" "}
                  {r.full_name}
                </p>
                <p className="truncate text-xs text-muted">{r.phone || "—"}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge tone={r.queue_status === "seen" ? "ok" : "wait"}>
                  {r.queue_status}
                </Badge>
                <Link
                  href={`/print/${r.id}`}
                  className="rounded-lg border border-border bg-white px-2.5 py-1.5 text-sm font-semibold text-brand shadow-sm hover:bg-brand-soft"
                >
                  Print
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
