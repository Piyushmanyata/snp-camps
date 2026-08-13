"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { parseRegistrationNumber } from "@/lib/qr";
import { formatCampDay, queueLabel, queueTone } from "@/lib/types";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBox,
  Input,
} from "@/components/ui";
import { mapDbError } from "@/lib/public-error";

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
  checked_in_by?: string | null;
  seen_by?: string | null;
  printed_at?: string | null;
  seen_at?: string | null;
  volunteer_name?: string | null;
  checked_in_by_name?: string | null;
  seen_by_name?: string | null;
};

const TIMESTAMP_FORMATTER = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

function fmtTs(iso: string | null | undefined) {
  if (!iso) return null;
  try {
    return TIMESTAMP_FORMATTER.format(new Date(iso));
  } catch {
    return null;
  }
}

function mapRows(data: Record<string, unknown>[]): AdminPatientRow[] {
  return data.map((patient) => {
    const camp = patient.camps as
      | { name: string }
      | { name: string }[]
      | null;
    const day = patient.camp_days as
      | { day_date: string }
      | { day_date: string }[]
      | null;
    const volunteer = patient.volunteer as
      | { full_name: string }
      | { full_name: string }[]
      | null;
    const checkedInByRel = patient.checked_in_by_profile as
      | { full_name: string }
      | { full_name: string }[]
      | null;
    const seenByProfile = patient.seen_by_profile as
      | { full_name: string }
      | { full_name: string }[]
      | null;
    const createdBy = (patient.created_by as string | null) ?? null;
    const checkedInBy = (patient.checked_in_by as string | null) ?? null;
    const seenBy = (patient.seen_by as string | null) ?? null;
    const volunteerName = Array.isArray(volunteer)
      ? volunteer[0]?.full_name ?? null
      : volunteer?.full_name ?? null;
    const checkedInByName = Array.isArray(checkedInByRel)
      ? checkedInByRel[0]?.full_name ?? null
      : checkedInByRel?.full_name ?? null;
    const seenByName = Array.isArray(seenByProfile)
      ? seenByProfile[0]?.full_name ?? null
      : seenByProfile?.full_name ?? null;
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
      checked_in_by: checkedInBy,
      seen_by: seenBy,
      printed_at: (patient.printed_at as string | null) ?? null,
      seen_at: (patient.seen_at as string | null) ?? null,
      volunteer_name: volunteerName,
      checked_in_by_name: checkedInByName,
      seen_by_name: seenByName,
    };
  });
}

const SELECT =
  "id, reg_no, full_name, phone, queue_status, gender, age, created_at, camp_id, created_by, checked_in_by, seen_by, printed_at, seen_at, camps(name), camp_days(day_date), volunteer:profiles!created_by(full_name), checked_in_by_profile:profiles!checked_in_by(full_name), seen_by_profile:profiles!seen_by(full_name)";

export function AdminPatients({
  initial,
  totalCount,
  showAttribution = true,
}: {
  initial: AdminPatientRow[];
  totalCount?: number;
  showAttribution?: boolean;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "registered" | "seen">("all");
  const [page, setPage] = useState(0);
  const isDefaultView = !q.trim() && filter === "all" && page === 0;
  const [snapshot, setSnapshot] = useState<{
    source: AdminPatientRow[];
    rows: AdminPatientRow[];
    total: number;
    isDefault: boolean;
  } | null>(null);

  const current =
    snapshot?.source === initial && (!isDefaultView || snapshot.isDefault)
      ? snapshot
      : {
          source: initial,
          rows: initial,
          total: totalCount ?? initial.length,
          isDefault: true,
        };

  const rows = current.rows;
  const total = current.total;
  const [loading, setLoading] = useState(false);
  const isSearching = loading && !isDefaultView;
  const requestId = useRef(0);

  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const mutationBusy = deletingId !== null;

  useEffect(() => {
    if (isDefaultView) return;

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const currentRequest = ++requestId.current;
      setLoading(true);
      setError(null);
      try {
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
              setSnapshot({
                source: initial,
                rows: [],
                total: 0,
                isDefault: false,
              });
              return;
            }
            query = query.or(filters.join(","));
          } else {
            const escaped = term.replace(/[%_]/g, "\\$&");
            query = query.ilike("full_name_normalized", "%" + escaped + "%");
          }
        }

        query = query.abortSignal(controller.signal);
        const { data, count, error: queryError } = await query;
        if (currentRequest !== requestId.current) return;
        if (queryError) {
          setError("Patient search failed. Try again.");
          return;
        }

        setSnapshot({
          source: initial,
          rows: mapRows((data || []) as Record<string, unknown>[]),
          total: count ?? 0,
          isDefault: false,
        });
      } catch {
        if (currentRequest === requestId.current && !controller.signal.aborted) {
          setError("Patient search failed. Check your connection and try again.");
        }
      } finally {
        if (currentRequest === requestId.current) setLoading(false);
      }
    }, 300);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
      requestId.current += 1;
    };
  }, [filter, initial, isDefaultView, page, q]);

  async function removePatient(row: AdminPatientRow) {
    if (mutationBusy) return;
    const ok = window.confirm(
      `Remove registration #${row.reg_no} for ${row.full_name}?\nThe registration is permanently deleted.`,
    );
    if (!ok) return;

    setDeletingId(row.id);
    setError(null);
    try {
      const supabase = createClient();
      const { error: err } = await supabase
        .from("patients")
        .delete()
        .eq("id", row.id);

      if (err) {
        setError(
          mapDbError(err, {
            context: "admin-patients.delete",
            fallback: "Could not remove this patient. Try again.",
          }),
        );
        return;
      }

      setSnapshot((prev) => {
        const usePrevious =
          prev?.source === initial && (!isDefaultView || prev.isDefault);
        const currentRows = usePrevious ? prev.rows : initial;
        const currentTotal = usePrevious
          ? prev.total
          : (totalCount ?? initial.length);
        return {
          source: initial,
          rows: currentRows.filter((p) => p.id !== row.id),
          total: Math.max(0, currentTotal - 1),
          isDefault: isDefaultView,
        };
      });
      router.refresh();
    } catch {
      setError("Could not remove this patient. Check your connection and try again.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="mb-3 space-y-3">
        <Input
          label="Filter list"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(0);
            setError(null);
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
                setError(null);
              }}
              className={`pressable min-h-12 min-w-12 rounded-full px-3.5 py-2 text-sm font-semibold transition-colors ${
                filter === key
                  ? "bg-brand text-white"
                  : "border border-border bg-white text-muted hover:bg-brand-soft hover:text-brand"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <ErrorBox message={error} />

      {isSearching ? (
        <p className="py-8 text-center text-sm text-muted" role="status">
          Searching patients…
        </p>
      ) : !rows.length ? (
        <EmptyState>
          {isDefaultView
            ? "No patients registered yet."
            : "No patients match your search or filter."}
        </EmptyState>
      ) : (
        <ul className="max-h-[32rem] divide-y divide-border overflow-y-auto">
          {rows.map((r) => {
            const createdAt = showAttribution ? fmtTs(r.created_at) : null;
            const printedAt = showAttribution ? fmtTs(r.printed_at) : null;
            const seenAt = showAttribution ? fmtTs(r.seen_at) : null;
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
                        {createdAt ? ` · ${createdAt}` : ""}
                        {r.volunteer_name
                          ? ` · by ${r.volunteer_name}`
                          : r.created_by
                            ? " · by staff"
                            : " · desk / walk-in"}
                      </p>
                      {r.printed_at ? (
                        <p>
                          <span className="font-semibold text-foreground/70">
                            Printed
                          </span>
                          {printedAt ? ` · ${printedAt}` : ""}
                          {r.checked_in_by_name
                            ? ` · by ${r.checked_in_by_name}`
                            : r.checked_in_by
                              ? " · by staff"
                              : ""}
                        </p>
                      ) : null}
                      {r.queue_status === "seen" || r.seen_at ? (
                        <p>
                          <span className="font-semibold text-foreground/70">
                            Seen
                          </span>
                          {seenAt ? ` · ${seenAt}` : ""}
                          {r.seen_by_name
                            ? ` · by ${r.seen_by_name}`
                            : r.seen_by
                              ? " · by staff"
                              : ""}
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
                    className="pressable inline-flex min-h-12 items-center rounded-lg border border-border bg-white px-2.5 py-2 text-sm font-semibold text-brand hover:bg-brand-soft"
                  >
                    Print prescription
                  </Link>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    className="w-auto"
                    disabled={mutationBusy}
                    loading={deletingId === r.id}
                    onClick={() => removePatient(r)}
                  >
                    {deletingId === r.id ? "Removing…" : "Remove registration"}
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
            disabled={page === 0 || isSearching}
            onClick={() => {
              setPage((value) => Math.max(0, value - 1));
              setError(null);
            }}
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
            disabled={(page + 1) * 50 >= total || isSearching}
            onClick={() => {
              setPage((value) => value + 1);
              setError(null);
            }}
          >
            Next
          </Button>
        </div>
      ) : null}
    </div>
  );
}
