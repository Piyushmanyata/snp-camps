"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { parseRegistrationNumber } from "@/lib/qr";
import { formatCampDay, queueLabel, queueTone } from "@/lib/types";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBox,
  Input,
  Stat,
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
  day_date?: string | null;
  created_by?: string | null;
  seen_by?: string | null;
  queued_at?: string | null;
  seen_at?: string | null;
  volunteer_name?: string | null;
  doctor_name?: string | null;
};

function fmtTs(iso: string | null | undefined) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return null;
  }
}

function waitMinutes(
  queuedAt: string | null | undefined,
  seenAt: string | null | undefined,
  createdAt: string | null | undefined,
) {
  const end = seenAt ? new Date(seenAt).getTime() : NaN;
  const start = queuedAt
    ? new Date(queuedAt).getTime()
    : createdAt
      ? new Date(createdAt).getTime()
      : NaN;
  if (!Number.isFinite(end) || !Number.isFinite(start) || end < start) {
    return null;
  }
  return Math.round((end - start) / 60_000);
}

async function resolveNames(
  rows: {
    created_by?: string | null;
    seen_by?: string | null;
  }[],
): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.created_by) ids.add(r.created_by);
    if (r.seen_by) ids.add(r.seen_by);
  }
  const map = new Map<string, string>();
  if (!ids.size) return map;
  const supabase = createClient();
  const { data } = await supabase
    .from("profiles")
    .select("id, full_name")
    .in("id", [...ids]);
  for (const p of data || []) {
    map.set(p.id as string, (p.full_name as string) || "—");
  }
  return map;
}

function mapRows(
  data: Record<string, unknown>[],
  names: Map<string, string>,
): AdminPatientRow[] {
  return data.map((patient) => {
    const camp = patient.camps as
      | { name: string }
      | { name: string }[]
      | null;
    const day = patient.camp_days as
      | { day_date: string }
      | { day_date: string }[]
      | null;
    const createdBy = (patient.created_by as string | null) ?? null;
    const seenBy = (patient.seen_by as string | null) ?? null;
    return {
      id: patient.id as string,
      reg_no: patient.reg_no as number,
      full_name: patient.full_name as string,
      phone: (patient.phone as string | null) ?? null,
      queue_status: patient.queue_status as string,
      gender: (patient.gender as string | null) ?? null,
      age: (patient.age as number | null) ?? null,
      created_at: patient.created_at as string,
      camp_id: patient.camp_id as string,
      camps: Array.isArray(camp) ? camp[0] ?? null : camp,
      day_date: Array.isArray(day)
        ? day[0]?.day_date ?? null
        : day?.day_date ?? null,
      created_by: createdBy,
      seen_by: seenBy,
      queued_at: (patient.queued_at as string | null) ?? null,
      seen_at: (patient.seen_at as string | null) ?? null,
      volunteer_name: createdBy ? names.get(createdBy) ?? null : null,
      doctor_name: seenBy ? names.get(seenBy) ?? null : null,
    };
  });
}

const SELECT =
  "id, reg_no, full_name, phone, queue_status, gender, age, created_at, camp_id, camp_day_id, created_by, seen_by, queued_at, seen_at, camps(name), camp_days(day_date)";

export function AdminPatients({
  initial,
  totalCount,
  avgWaitMinutes = null,
  showAttribution = true,
}: {
  initial: AdminPatientRow[];
  totalCount?: number;
  avgWaitMinutes?: number | null;
  showAttribution?: boolean;
}) {
  const [rows, setRows] = useState(initial);
  const [total, setTotal] = useState(totalCount ?? initial.length);
  const [loading, setLoading] = useState(false);
  const firstQuery = useRef(true);
  const requestId = useRef(0);

  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<
    "all" | "registered" | "waiting" | "seen"
  >("all");
  const [page, setPage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    if (firstQuery.current) {
      firstQuery.current = false;
      return;
    }

    const timer = window.setTimeout(async () => {
      const currentRequest = ++requestId.current;
      setLoading(true);
      setError(null);
      const supabase = createClient();
      let query = supabase
        .from("patients")
        .select(SELECT, { count: "exact" })
        .order("created_at", { ascending: false })
        .range(page * 50, page * 50 + 49);

      if (filter !== "all") query = query.eq("queue_status", filter);

      const term = q.trim().toLowerCase();
      if (term) {
        if (/^\d+$/.test(term)) {
          const regNo = parseRegistrationNumber(term);
          const phone = term.slice(-10);
          const filters = [];
          if (regNo !== null) filters.push("reg_no.eq." + regNo);
          if (phone.length === 10) {
            filters.push("phone_normalized.eq." + phone);
          }
          if (!filters.length) {
            setLoading(false);
            setRows([]);
            setTotal(0);
            return;
          }
          query = query.or(filters.join(","));
        } else {
          const escaped = term.replace(/[%_]/g, "\\$&");
          query = query.ilike("full_name_normalized", "%" + escaped + "%");
        }
      }

      const { data, count, error: queryError } = await query;
      if (currentRequest !== requestId.current) return;
      if (queryError) {
        setLoading(false);
        setError("Patient search failed. Try again.");
        return;
      }

      const names = await resolveNames(
        (data || []) as { created_by?: string | null; seen_by?: string | null }[],
      );
      if (currentRequest !== requestId.current) return;
      setLoading(false);
      setRows(mapRows((data || []) as Record<string, unknown>[], names));
      setTotal(count ?? 0);
    }, 300);

    return () => {
      window.clearTimeout(timer);
      requestId.current += 1;
    };
  }, [filter, page, q]);

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
    setTotal((value) => Math.max(0, value - 1));
    setDeletingId(null);
  }

  return (
    <div className="space-y-3">
      {avgWaitMinutes != null && !Number.isNaN(avgWaitMinutes) ? (
        <div className="grid grid-cols-1 gap-2 sm:max-w-xs">
          <Stat
            label="Avg wait (queue → doctor)"
            value={
              avgWaitMinutes < 1
                ? "< 1 min"
                : `${Math.round(avgWaitMinutes)} min`
            }
            tone="wait"
          />
        </div>
      ) : null}

      <div className="mb-3 space-y-3">
        <Input
          label="Filter list"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(0);
          }}
          placeholder="Name, 10-digit phone, or exact reg no"
        />
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label="Filter by status"
        >
          {(
            [
              ["all", "All"],
              ["registered", "Registered"],
              ["waiting", "In queue"],
              ["seen", "Doctor seen"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => {
                setFilter(key);
                setPage(0);
              }}
              className={`pressable min-h-9 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
                filter === key
                  ? "bg-brand text-white shadow-sm"
                  : "border border-border bg-white text-muted hover:bg-brand-soft hover:text-brand"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <ErrorBox message={error} />

      {loading ? (
        <p className="py-8 text-center text-sm text-muted" role="status">
          Searching patients…
        </p>
      ) : !rows.length ? (
        <EmptyState>
          {total === 0
            ? "No patients registered yet."
            : "No patients match this filter."}
        </EmptyState>
      ) : (
        <ul className="max-h-[32rem] divide-y divide-border overflow-y-auto">
          {rows.map((r) => {
            const wait = waitMinutes(r.queued_at, r.seen_at, r.created_at);
            return (
              <li
                key={r.id}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">
                    <span className="tabular text-brand">#{r.reg_no}</span>{" "}
                    {r.full_name}
                  </p>
                  <p className="truncate text-xs text-muted">
                    {[
                      r.day_date ? formatCampDay(r.day_date) : null,
                      r.phone || null,
                      r.age != null ? `${r.age}y` : null,
                      r.gender,
                      r.camps?.name,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </p>
                  {showAttribution ? (
                    <div className="mt-1.5 space-y-0.5 text-xs text-muted">
                      <p>
                        <span className="font-semibold text-foreground/70">
                          Registered
                        </span>
                        {fmtTs(r.created_at)
                          ? ` · ${fmtTs(r.created_at)}`
                          : ""}
                        {r.volunteer_name
                          ? ` · by ${r.volunteer_name}`
                          : r.created_by
                            ? " · by staff"
                            : " · self / walk-in"}
                      </p>
                      {r.queued_at ? (
                        <p>
                          <span className="font-semibold text-foreground/70">
                            Queued
                          </span>
                          {` · ${fmtTs(r.queued_at)}`}
                        </p>
                      ) : null}
                      {r.queue_status === "seen" || r.seen_at ? (
                        <p>
                          <span className="font-semibold text-foreground/70">
                            Doctor seen
                          </span>
                          {fmtTs(r.seen_at) ? ` · ${fmtTs(r.seen_at)}` : ""}
                          {r.doctor_name
                            ? ` · Dr ${r.doctor_name}`
                            : r.seen_by
                              ? " · doctor"
                              : ""}
                          {wait != null ? ` · wait ${wait} min` : ""}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Badge tone={queueTone(r.queue_status)}>
                    {queueLabel(r.queue_status)}
                  </Badge>
                  <Link
                    href={`/print/${r.id}`}
                    className="pressable rounded-lg border border-border bg-white px-2.5 py-2 text-sm font-semibold text-brand shadow-sm hover:bg-brand-soft"
                  >
                    Print
                  </Link>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    className="w-auto"
                    disabled={deletingId === r.id}
                    loading={deletingId === r.id}
                    onClick={() => removePatient(r)}
                  >
                    {deletingId === r.id ? "…" : "Remove"}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {total > 50 ? (
        <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="w-auto"
            disabled={page === 0 || loading}
            onClick={() => setPage((value) => Math.max(0, value - 1))}
          >
            Previous
          </Button>
          <span className="text-xs text-muted">
            Page {page + 1} of {Math.ceil(total / 50)}
          </span>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="w-auto"
            disabled={(page + 1) * 50 >= total || loading}
            onClick={() => setPage((value) => value + 1)}
          >
            Next
          </Button>
        </div>
      ) : null}
    </div>
  );
}
