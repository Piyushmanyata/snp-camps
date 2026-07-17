"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Badge, Button, Card, ErrorBox, Input } from "@/components/ui";
import type { Camp } from "@/lib/types";

export function AdminCamps({ camps }: { camps: Camp[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [venue, setVenue] = useState("");
  const [campDate, setCampDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function createCamp(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { error: err } = await supabase.from("camps").insert({
      name: name.trim(),
      venue: venue.trim() || null,
      camp_date: campDate || null,
      is_active: camps.length === 0,
    });
    if (err) setError(err.message);
    else {
      setName("");
      setVenue("");
      setCampDate("");
      router.refresh();
    }
    setLoading(false);
  }

  async function activate(id: string) {
    setError(null);
    const supabase = createClient();
    const { error: err } = await supabase.rpc("set_active_camp", {
      p_camp_id: id,
    });
    if (err) setError(err.message);
    router.refresh();
  }

  return (
    <Card>
      <h2 className="mb-3 font-semibold">Camps</h2>
      <ul className="mb-4 divide-y divide-border">
        {camps.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-2 py-2">
            <div>
              <p className="font-medium">{c.name}</p>
              <p className="text-xs text-muted">
                {[c.venue, c.camp_date].filter(Boolean).join(" · ")}
              </p>
            </div>
            {c.is_active ? (
              <Badge tone="ok">Active</Badge>
            ) : (
              <button
                type="button"
                className="rounded-lg border border-border px-2 py-1 text-sm"
                onClick={() => activate(c.id)}
              >
                Set active
              </button>
            )}
          </li>
        ))}
        {!camps.length ? (
          <li className="py-2 text-sm text-muted">No camps yet.</li>
        ) : null}
      </ul>

      <form onSubmit={createCamp} className="space-y-3">
        <Input
          label="New camp name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input label="Venue" value={venue} onChange={(e) => setVenue(e.target.value)} />
        <Input
          label="Date"
          type="date"
          value={campDate}
          onChange={(e) => setCampDate(e.target.value)}
        />
        <ErrorBox message={error} />
        <Button type="submit" disabled={loading}>
          {loading ? "Creating…" : "Create camp"}
        </Button>
      </form>
    </Card>
  );
}
