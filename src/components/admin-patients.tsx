"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { formatCampDay, queueLabel, queueTone } from "@/lib/types";
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
  day_date?: string | null;
};

export function AdminPatients({
  initial,
  totalCount,
}: {
  initial: AdminPatientRow[];
  totalCount?: number;
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
        .select(
          "id, reg_no, full_name, phone, queue_status, gender, age, created_at, camp_id, camp_day_id, camps(name), camp_days(day_date)",
          { count: "exact" },
        )
        .order("created_at", { ascending: false })
        .range(page * 50, page * 50 + 49);

      if (filter !== "all") query = query.eq("queue_status", filter);

      const term = q.trim().toLowerCase();
      if (term) {
        if (/^\d+$/.test(term)) {
          const regNo = Number(term);
          const phone = term.slice(-10);
          query = query.or(
            phone.length === 10
              ? "reg_no.eq." + regNo + ",phone_normalized.eq." + phone
              : "reg_no.eq." + regNo,
          );
        } else {
          const escaped = term.replace(/[%_]/g, "\\$&");
          query = query.ilike("full_name_normalized", "%" + escaped + "%");
        }
      }

      const { data, count, error: queryError } = await query;
      if (currentRequest !== requestId.current) return;
      setLoading(false);
      if (queryError) {
        setError("Patient search failed. Try again.");
        return;
      }

      setRows(
        (data || []).map((patient) => {
          const camp = patient.camps as
            | { name: string }
            | { name: string }[]
            | null;
          const day = patient.camp_days as
            | { day_date: string }
            | { day_date: string }[]
            | null;
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
          };
        }),
      );
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
    <Card>
      <SectionTitle hint={total + " total"}>All patients</SectionTitle>

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
              ["registered", "Not queued"],
              ["waiting", "In queue"],
              ["seen", "Seen"],
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
        <ul className="max-h-[28rem] divide-y divide-border overflow-y-auto">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
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
          ))}
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
    </Card>
  );
}
