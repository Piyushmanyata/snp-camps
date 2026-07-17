"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Badge, Button, Card, Input } from "@/components/ui";

type Row = {
  id: string;
  reg_no: number;
  full_name: string;
  phone: string | null;
  queue_status: string;
};

export function AdminSearch() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
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
      <h2 className="mb-3 font-semibold">Search patients</h2>
      <form onSubmit={search} className="mb-3 flex gap-2">
        <div className="flex-1">
          <Input
            label="Name, phone, or reg no"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="flex items-end">
          <Button type="submit" className="w-auto min-w-24" disabled={loading}>
            {loading ? "…" : "Go"}
          </Button>
        </div>
      </form>
      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center justify-between py-2">
            <div>
              <p className="font-medium">
                #{r.reg_no} {r.full_name}
              </p>
              <p className="text-xs text-muted">{r.phone}</p>
            </div>
            <div className="flex items-center gap-2">
              <Badge tone={r.queue_status === "seen" ? "ok" : "wait"}>
                {r.queue_status}
              </Badge>
              <Link href={`/print/${r.id}`} className="text-sm text-brand underline">
                Print
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
