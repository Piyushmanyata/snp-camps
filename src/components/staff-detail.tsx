"use client";

import { useEffect, useState } from "react";
import {
  Badge,
  EmptyState,
  ErrorBox,
  Spinner,
  Stat,
} from "@/components/ui";
import { queueLabel, queueTone } from "@/lib/types";

export type StaffPerson = {
  id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  role: string;
  created_at?: string;
  disabled_at?: string | null;
  team_lead_id?: string | null;
};

type PatientRow = {
  id: string;
  reg_no: number;
  full_name: string;
  queue_status: string;
  created_at?: string;
};

type Kpis = {
  total: number;
  seen?: number;
};

export function StaffDetailPanel({
  person,
  role,
  onClose,
}: {
  person: StaffPerson;
  role: "volunteer" | "team_lead";
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [patients, setPatients] = useState<PatientRow[]>([]);

  function closeAndRestoreFocus() {
    onClose();
    window.requestAnimationFrame(() => {
      document.getElementById(`staff-detail-trigger-${person.id}`)?.focus();
    });
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/admin/staff-detail?id=${encodeURIComponent(person.id)}&role=${role}`,
        );
        if (cancelled) return;
        if (!res.ok) {
          setError(
            res.status === 403
              ? "You are not allowed to view these staff details."
              : res.status === 404
                ? "Staff member not found."
                : "Staff details could not be loaded. Try again.",
          );
          setLoading(false);
          return;
        }
        const json = (await res.json()) as {
          kpis?: Kpis;
          patients?: PatientRow[];
        };
        setKpis(json.kpis || null);
        setPatients(json.patients || []);
      } catch {
        if (!cancelled) setError("Network error loading details");
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [person.id, role]);

  return (
    <div className="mt-3 space-y-3 rounded-2xl border border-brand/20 bg-brand-soft/30 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-base font-bold text-foreground">
            {person.full_name || "—"}
          </p>
          <p className="truncate text-xs text-muted">
            {[person.email, person.phone].filter(Boolean).join(" · ") ||
              "No contact on file"}
          </p>
        </div>
        <button
          type="button"
          onClick={closeAndRestoreFocus}
          className="pressable min-h-12 min-w-12 shrink-0 rounded-lg border border-border bg-white px-3 py-2 text-sm font-semibold text-muted hover:bg-background"
        >
          Close
        </button>
      </div>

      {loading ? (
        <div
          className="flex items-center justify-center gap-2 py-6 text-sm text-muted"
          role="status"
        >
          <Spinner /> Loading KPIs…
        </div>
      ) : error ? (
        <ErrorBox message={error} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Registered" value={kpis?.total ?? 0} tone="ok" />
            <Stat label="Seen" value={kpis?.seen ?? 0} tone="ok" />
          </div>

          <div>
            <p className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">
              Patients registered by this staff member
            </p>
            {patients.length ? (
              <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-xl border border-border bg-white">
                {patients.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center justify-between gap-2 px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        <span className="tabular text-brand">#{p.reg_no}</span>{" "}
                        {p.full_name}
                      </p>
                      <p className="text-xs text-muted">
                        {p.created_at
                          ? new Date(p.created_at).toLocaleString("en-IN", {
                                hour: "2-digit",
                                minute: "2-digit",
                                day: "numeric",
                                month: "short",
                              })
                          : "Registration time unavailable"}
                      </p>
                    </div>
                    <Badge tone={queueTone(p.queue_status)}>
                      {queueLabel(p.queue_status)}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState>No patients registered yet.</EmptyState>
            )}
          </div>
        </>
      )}
    </div>
  );
}
