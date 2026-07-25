"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBox,
  Input,
} from "@/components/ui";
import type { Camp } from "@/lib/types";
import { mapDbError } from "@/lib/public-error";

export function AdminCamps({ camps }: { camps: Camp[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [venue, setVenue] = useState("");
  const [campDate, setCampDate] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [campError, setCampError] = useState<{
    campId: string;
    message: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function createCamp(e: React.FormEvent) {
    e.preventDefault();
    setCreateError(null);
    if (!name.trim()) {
      setCreateError("Enter a camp name.");
      return;
    }
    setLoading(true);
    try {
      const supabase = createClient();
      const { error: err } = await supabase.from("camps").insert({
        name: name.trim(),
        venue: venue.trim() || null,
        camp_date: campDate || null,
        is_active: camps.length === 0,
      });
      if (err) {
        setCreateError(
          mapDbError(err, {
            context: "admin-camps.create",
            fallback: "Could not create the camp. Try again.",
          }),
        );
      } else {
        setName("");
        setVenue("");
        setCampDate("");
        router.refresh();
      }
    } catch {
      setCreateError("Could not create the camp. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  async function activate(id: string) {
    if (activatingId || deletingId) return;
    setCampError(null);
    setActivatingId(id);
    try {
      const supabase = createClient();
      const { error: err } = await supabase.rpc("set_active_camp", {
        p_camp_id: id,
      });
      if (err) {
        setCampError({
          campId: id,
          message: mapDbError(err, {
            context: "admin-camps.activate",
            fallback: "Could not activate this camp. Try again.",
          }),
        });
      } else router.refresh();
    } catch (e) {
      setCampError({
        campId: id,
        message: mapDbError(e, {
          context: "admin-camps.activate.network",
          fallback:
            "Could not activate this camp. Check your connection and try again.",
        }),
      });
    } finally {
      setActivatingId(null);
    }
  }

  async function removeCamp(c: Camp) {
    const label = c.name;
    if (
      !window.confirm(
        `Delete camp “${label}”? Only empty camps (no patients) can be deleted. Days will be removed too.`,
      )
    ) {
      return;
    }
    if (activatingId || deletingId) return;
    setDeletingId(c.id);
    setCampError(null);
    try {
      const supabase = createClient();
      const { error: err } = await supabase.rpc("delete_camp", {
        p_camp_id: c.id,
      });
      if (err) {
        setCampError({
          campId: c.id,
          message: mapDbError(err, {
            context: "admin-camps.delete",
            fallback: "Could not delete this camp. Try again.",
          }),
        });
      } else router.refresh();
    } catch (e) {
      setCampError({
        campId: c.id,
        message: mapDbError(e, {
          context: "admin-camps.delete.network",
          fallback:
            "Could not delete this camp. Check your connection and try again.",
        }),
      });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">One camp active at a time.</p>
      <ul className="mb-4 divide-y divide-border">
        {camps.map((c) => (
          <li
            key={c.id}
            className="space-y-2 py-2.5"
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate font-medium">{c.name}</p>
                <p className="truncate text-xs text-muted">
                  {[c.venue, c.camp_date].filter(Boolean).join(" · ") || "—"}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {c.is_active ? (
                  <Badge tone="ok">Active</Badge>
                ) : (
                  <button
                    type="button"
                    className="rounded-lg border border-border bg-white px-2.5 py-1.5 text-sm font-medium shadow-sm transition hover:bg-brand-soft disabled:opacity-50"
                    disabled={Boolean(activatingId || deletingId)}
                    onClick={() => activate(c.id)}
                  >
                    {activatingId === c.id ? "Activating…" : "Set active"}
                  </button>
                )}
                <button
                  type="button"
                  className="pressable rounded-lg border border-danger/20 bg-danger-soft px-2.5 py-1.5 text-sm font-medium text-danger transition hover:bg-danger/10 disabled:opacity-50"
                  disabled={Boolean(activatingId || deletingId)}
                  onClick={() => removeCamp(c)}
                >
                  {deletingId === c.id ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
            <ErrorBox
              message={campError?.campId === c.id ? campError.message : null}
            />
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
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
        </div>
        <Input
          label="Date"
          type="date"
          value={campDate}
          onChange={(e) => setCampDate(e.target.value)}
        />
        <ErrorBox message={createError} />
        <Button type="submit" disabled={loading} variant="secondary">
          {loading ? "Creating…" : "Create camp"}
        </Button>
      </form>
    </div>
  );
}
