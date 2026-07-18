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
};

type PatientRow = {
  id: string;
  reg_no: number;
  full_name: string;
  phone: string | null;
  queue_status: string;
  seen_at?: string | null;
  created_at?: string;
};

type Kpis = {
  total: number;
  today: number;
  waiting?: number;
  seen?: number;
  label: string;
};

export function StaffDetailPanel({
  person,
  role,
  onClose,
}: {
  person: StaffPerson;
  role: "doctor" | "volunteer";
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [patients, setPatients] = useState<PatientRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await fetch(
          `/api/admin/staff-detail?id=${encodeURIComponent(person.id)}&role=${role}`,
        );
        const json = (await res.json()) as {
          error?: string;
          kpis?: Kpis;
          patients?: PatientRow[];
        };
        if (cancelled) return;
        if (!res.ok) {
          setError(json.error || "Could not load details");
          setLoading(false);
          return;
        }
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
          onClick={onClose}
          className="pressable shrink-0 rounded-lg border border-border bg-white px-2.5 py-1.5 text-xs font-semibold text-muted hover:bg-background"
        >
          Close
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted">
          <Spinner /> Loading KPIs…
        </div>
      ) : error ? (
        <ErrorBox message={error} />
      ) : (
        <>
          <div
            className={`grid gap-2 ${
              role === "volunteer" ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-2"
            }`}
          >
            <Stat label={kpis?.label || "Total"} value={kpis?.total ?? 0} tone="ok" />
            <Stat label="Today" value={kpis?.today ?? 0} />
            {role === "volunteer" ? (
              <>
                <Stat label="In queue" value={kpis?.waiting ?? 0} tone="wait" />
                <Stat label="Doctor seen" value={kpis?.seen ?? 0} tone="ok" />
              </>
            ) : null}
          </div>

          <div>
            <p className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">
              {role === "doctor" ? "Patients seen" : "Patients registered"}
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
                        {p.phone || "—"}
                        {role === "doctor" && p.seen_at
                          ? ` · ${new Date(p.seen_at).toLocaleString("en-IN", {
                              hour: "2-digit",
                              minute: "2-digit",
                              day: "numeric",
                              month: "short",
                            })}`
                          : p.created_at
                            ? ` · ${new Date(p.created_at).toLocaleString("en-IN", {
                                hour: "2-digit",
                                minute: "2-digit",
                                day: "numeric",
                                month: "short",
                              })}`
                            : ""}
                      </p>
                    </div>
                    <Badge tone={queueTone(p.queue_status)}>
                      {queueLabel(p.queue_status)}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState>
                {role === "doctor"
                  ? "No patients marked seen yet."
                  : "No patients registered by this volunteer yet."}
              </EmptyState>
            )}
          </div>
        </>
      )}
    </div>
  );
}
