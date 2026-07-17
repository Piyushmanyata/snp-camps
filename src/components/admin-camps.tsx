"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBox,
  Input,
  SectionTitle,
} from "@/components/ui";
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
      <SectionTitle hint="One active at a time">Camps</SectionTitle>
      <ul className="mb-4 divide-y divide-border">
        {camps.map((c) => (
          <li
            key={c.id}
            className="flex items-center justify-between gap-2 py-2.5"
          >
            <div className="min-w-0">
              <p className="truncate font-medium">{c.name}</p>
              <p className="truncate text-xs text-muted">
                {[c.venue, c.camp_date].filter(Boolean).join(" · ") || "—"}
              </p>
            </div>
            {c.is_active ? (
              <Badge tone="ok">Active</Badge>
            ) : (
              <button
                type="button"
                className="rounded-lg border border-border bg-white px-2.5 py-1.5 text-sm font-medium shadow-sm transition hover:bg-brand-soft"
                onClick={() => activate(c.id)}
              >
                Set active
              </button>
            )}
          </li>
        ))}
        {!camps.length ? (
          <li className="py-2">
            <EmptyState>No camps yet — create the first below.</EmptyState>
          </li>
        ) : null}
      </ul>

      <form onSubmit={createCamp} className="space-y-3 border-t border-border pt-4">
        <p className="text-sm font-medium text-foreground/80">New camp</p>
        <Input
          label="Camp name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. SNP Eye Camp"
        />
        <Input
          label="Venue"
          value={venue}
          onChange={(e) => setVenue(e.target.value)}
          placeholder="SIKAR BHAWAN"
        />
        <Input
          label="Date"
          type="date"
          value={campDate}
          onChange={(e) => setCampDate(e.target.value)}
        />
        <ErrorBox message={error} />
        <Button type="submit" disabled={loading} variant="secondary">
          {loading ? "Creating…" : "Create camp"}
        </Button>
      </form>
    </Card>
  );
}
